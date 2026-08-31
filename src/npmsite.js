import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLimiter, readJsonCache, writeJsonCache, safeFileName } from './registry.js';

/**
 * npm サイト（https://www.npmjs.com）のパッケージページから「Dependencies」欄を取得する。
 *
 * サイトは Cloudflare が非ブラウザからのアクセスを 403 で拒否するため、
 * ローカルにインストールされた Edge / Chrome をヘッドレスで 1 つ起動し、同じセッション内にページを順に開いて DOM を取り出す。
 * 1 セッションで Cookie を保持するため、パッケージごとにプロセスを起動するより Cloudflare の確認ページが出にくく、
 * 出た場合も解決を待てる。
 *
 * ブラウザの操作方法（engine）は 2 通り:
 *   cdp        : DevTools プロトコルを --remote-debugging-pipe で直接使う（既定。追加パッケージ不要）
 *   playwright : Playwright (playwright-core) を使う。`npm install playwright-core` が必要（ブラウザは同じくローカルの Edge / Chrome）
 */

const SITE_ORIGIN = 'https://www.npmjs.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0';

/** 既定の待ち時間（ミリ秒）。サイトへの連続アクセスを避けるため、取得ごとにこの範囲のランダムな時間だけ待つ。 */
export const DEFAULT_WAIT_MS = { min: 1000, max: 3000 };
/** Cloudflare の確認ページで止まったときに、再試行前に待つ時間（ミリ秒）。 */
export const CHALLENGE_RETRY_WAIT_MS = 15000;
/** 取得エンジンの選択肢 */
export const SITE_ENGINES = ['cdp', 'playwright'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * そのバージョンの Dependencies タブの URL。
 * スコープ付き (@scope/name) の '@' と '/' はレジストリ API と違いそのまま使う（%2F だとサイトが Dependencies 欄の無いページを返す）。
 */
export function siteUrl(name, version) {
  const encoded = name
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%40/g, '@'))
    .join('/');
  return `${SITE_ORIGIN}/package/${encoded}/v/${encodeURIComponent(version)}?activeTab=dependencies`;
}

/** 候補パスから使えるブラウザを探す。環境変数 NLD_BROWSER があれば最優先。 */
export async function findBrowser() {
  const env = process.env;
  const candidates = [];
  if (env.NLD_BROWSER) candidates.push(env.NLD_BROWSER);
  if (process.platform === 'win32') {
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

/**
 * ページ HTML の状態を判定する。
 *  blocked   : Cloudflare に拒否された（再試行しても無駄）
 *  challenge : Cloudflare の確認ページ（「しばらくお待ちください」）。待てば通ることがある
 *  ready     : Dependencies 欄がある
 *  other     : それ以外（読み込み中、または Dependencies 欄の無いページ）
 */
export function classifyPage(html) {
  if (/Attention Required!\s*\|\s*Cloudflare/i.test(html)) return 'blocked';
  if (/<title>[^<]*(Just a moment|しばらくお待ちください)/i.test(html) || /cf-chl|challenge-platform/i.test(html)) return 'challenge';
  if (/<ul[^>]*aria-label="Dependencies"/i.test(html) || /<h2[^>]*>\s*Dependencies\s*\(/i.test(html)) return 'ready';
  return 'other';
}

/**
 * npm サイトのページ HTML から「Dependencies」欄のライブラリ名を取り出す。
 * 「Dev Dependencies」は含めない。
 * @returns {{ names: string[], count: number|null }} count は見出し "Dependencies (N)" の N（見つからなければ null）
 */
export function parseDependencies(html) {
  const state = classifyPage(html);
  if (state === 'blocked') throw new Error('npm サイトが自動アクセスを拒否しました (Cloudflare)');
  if (state === 'challenge') throw new Error('npm サイトの確認ページ (Cloudflare) から先に進めませんでした');
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  const headingMatch = html.match(/<h2[^>]*>\s*Dependencies\s*\(\s*(?:<!--\s*-->)?\s*(\d+)\s*(?:<!--\s*-->)?\s*\)\s*<\/h2>/i);
  const count = headingMatch ? Number(headingMatch[1]) : null;

  const listMatch = html.match(/<ul[^>]*aria-label="Dependencies"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!listMatch && count == null) {
    if (/404|not found/i.test(title)) throw new Error(`npm サイトにページがありません (${title})`);
    throw new Error(`npm サイトのページに Dependencies 欄が見つかりません${title ? ` (${title})` : ''}`);
  }
  const names = [];
  if (listMatch) {
    for (const m of listMatch[1].matchAll(/<a[^>]*href="\/package\/[^"]+"[^>]*>([^<]*)<\/a>/g)) {
      const name = decodeEntities(m[1]).trim();
      if (name) names.push(name);
    }
  }
  names.sort();
  return { names, count };
}

/** 待ち時間指定を { min, max }（ミリ秒、0 以上、min <= max）に正規化する。 */
export function normalizeWait(waitMs) {
  if (!waitMs || typeof waitMs !== 'object') return { ...DEFAULT_WAIT_MS };
  const toMs = (v, fallback) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : fallback);
  const min = toMs(waitMs.min, DEFAULT_WAIT_MS.min);
  const max = toMs(waitMs.max, DEFAULT_WAIT_MS.max);
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** engine 指定を正規化する（不正なら既定 'cdp'）。 */
export function normalizeEngine(engine) {
  return SITE_ENGINES.includes(engine) ? engine : 'cdp';
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;|&#47;/g, '/');
}

/**
 * ページの状態を定期的に見て、Dependencies 欄が現れたら HTML を返す（両エンジン共通）。
 * Cloudflare の確認ページが出ている間は待ち続け、timeoutMs を超えたら失敗にする。
 * @param {() => Promise<{ ready: string, html: string }>} getSnapshot  document.readyState と outerHTML を返す
 */
export async function waitForDependenciesHtml(getSnapshot, { timeoutMs = 45000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'other';
  let completeSince = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let snapshot;
    try {
      snapshot = await getSnapshot();
    } catch {
      continue; // ナビゲーション中は評価できないことがある
    }
    const html = snapshot?.html ?? '';
    lastState = classifyPage(html);
    if (lastState === 'ready') return html;
    if (lastState === 'blocked') throw new Error('npm サイトが自動アクセスを拒否しました (Cloudflare)');
    if (lastState === 'other' && snapshot.ready === 'complete') {
      // 読み込みは終わったのに Dependencies 欄が無い。少しだけ待って変わらなければ諦める
      completeSince ??= Date.now();
      if (Date.now() - completeSince > 3000) return html;
    } else {
      completeSince = null;
    }
  }
  if (lastState === 'challenge') throw new Error(`npm サイトの確認ページ (Cloudflare) から先に進めませんでした (${timeoutMs / 1000} 秒)`);
  throw new Error(`タイムアウト (${timeoutMs / 1000} 秒)`);
}

const COMMON_BROWSER_ARGS = [
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--no-first-run',
  '--no-default-browser-check',
];

// ---------------------------------------------------------------- engine: cdp (DevTools protocol over pipe)

/**
 * ヘッドレスブラウザ 1 プロセスを DevTools プロトコルで操作するセッション。
 * --remote-debugging-pipe により、fd 3（送信）/ fd 4（受信）で NUL 区切りの JSON をやり取りする（WebSocket 不要）。
 */
export class BrowserSession {
  constructor(browserPath, profileDir) {
    this.browserPath = browserPath;
    this.profileDir = profileDir;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.exited = null; // 終了理由
  }

  async start() {
    await mkdir(this.profileDir, { recursive: true });
    const args = [
      '--headless=new',
      '--disable-gpu',
      ...COMMON_BROWSER_ARGS,
      '--remote-debugging-pipe',
      `--user-agent=${USER_AGENT}`,
      `--user-data-dir=${this.profileDir}`,
      '--window-size=1280,900',
      'about:blank',
    ];
    this.proc = spawn(this.browserPath, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    const [, , , toBrowser, fromBrowser] = this.proc.stdio;
    this.toBrowser = toBrowser;
    fromBrowser.setEncoding('utf8');
    fromBrowser.on('data', (chunk) => this.onData(chunk));
    const onExit = (reason) => {
      this.exited = reason;
      for (const { reject } of this.pending.values()) reject(new Error(`ブラウザが終了しました (${reason})`));
      this.pending.clear();
    };
    this.proc.on('exit', (code, signal) => onExit(signal ?? `code ${code}`));
    this.proc.on('error', (err) => onExit(err.message));
    toBrowser.on('error', () => {});
    // 起動確認
    await this.send('Browser.getVersion', {}, undefined, 20000);
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\0')) >= 0) {
      const text = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message ?? 'CDP error'}`));
        else resolve(msg.result ?? {});
      }
      // イベント（id 無し）は使わない
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    if (this.exited) return Promise.reject(new Error(`ブラウザが終了しています (${this.exited})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ブラウザ応答なし: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.toBrowser.write(JSON.stringify(payload) + '\0');
    });
  }

  /** 新しいタブで URL を開き、Dependencies 欄が現れるまで待って HTML を返す。 */
  async fetchHtml(url, { timeoutMs = 45000 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    try {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
      await this.send('Page.navigate', { url }, sessionId);
      const expression =
        'JSON.stringify({ ready: document.readyState, html: document.documentElement ? document.documentElement.outerHTML : "" })';
      return await waitForDependenciesHtml(
        async () => {
          const r = await this.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
          return JSON.parse(r.result?.value ?? '{}');
        },
        { timeoutMs },
      );
    } finally {
      await this.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  async close() {
    if (!this.proc || this.exited) return;
    await this.send('Browser.close', {}, undefined, 5000).catch(() => {});
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          this.proc.kill();
        } catch {
          // 既に終了
        }
        resolve();
      }, 3000);
      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

// ---------------------------------------------------------------- engine: playwright

/**
 * Playwright (playwright-core) でブラウザを操作するセッション。
 * ブラウザは cdp エンジンと同じくローカルの Edge / Chrome を executablePath で指定するので、
 * `npx playwright install` によるブラウザのダウンロードは不要。パッケージだけ `npm install playwright-core` で入れる。
 */
export class PlaywrightSession {
  /**
   * @param {string} browserPath
   * @param {string} profileDir
   * @param {{ playwrightModule?: object }} [options]  テスト用に playwright モジュール相当を差し替えられる
   */
  constructor(browserPath, profileDir, options = {}) {
    this.browserPath = browserPath;
    this.profileDir = profileDir;
    this.playwrightModule = options.playwrightModule ?? null;
    this.context = null;
  }

  static async loadModule() {
    for (const name of ['playwright-core', 'playwright']) {
      try {
        return await import(name);
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND' && !/Cannot find (module|package)/.test(err?.message ?? '')) throw err;
      }
    }
    throw new Error(
      'Playwright が見つかりません。このツールのフォルダで `npm install playwright-core` を実行してください（ブラウザはローカルの Edge / Chrome を使うので追加ダウンロードは不要）',
    );
  }

  async start() {
    const pw = this.playwrightModule ?? (await PlaywrightSession.loadModule());
    await mkdir(this.profileDir, { recursive: true });
    this.context = await pw.chromium.launchPersistentContext(this.profileDir, {
      executablePath: this.browserPath,
      headless: true,
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      args: COMMON_BROWSER_ARGS,
    });
  }

  async fetchHtml(url, { timeoutMs = 45000 } = {}) {
    const page = await this.context.newPage();
    try {
      // 読み込み完了は待たず（確認ページで止まることがある）、以降は共通のポーリングで判断する
      await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs }).catch(() => {});
      return await waitForDependenciesHtml(
        async () => ({ ready: await page.evaluate('document.readyState'), html: await page.content() }),
        { timeoutMs },
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close() {
    if (!this.context) return;
    const c = this.context;
    this.context = null;
    await c.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- client

/**
 * npm サイトの Dependencies 取得クライアント。
 * - ファイルキャッシュ（.cache/<name>@<version>.npmsite.json）。バージョンが決まれば内容は変わらないので再利用してよい
 * - ブラウザは 1 プロセスを使い回し、ページは 1 つずつ順に開く（既定 concurrency 1）
 * - 取得ごとに可変（ランダム）の待ち時間を入れる（キャッシュヒット時は待たない）
 * - Cloudflare の確認ページで止まったら長めに待って 1 回だけ再試行する
 * - 使い終わったら close() でブラウザを終了する
 */
export class NpmSiteClient {
  /**
   * @param {{ cacheDir?: string|null, browserPath?: string|null, profileDir?: string|null, profileBaseDir?: string|null, engine?: 'cdp'|'playwright',
   *           concurrency?: number, timeoutMs?: number,
   *           waitMs?: { min: number, max: number }, onWait?: (ev: { name: string, version: string, waitMs: number, reason?: string }) => void,
   *           dumpDomImpl?: (url: string) => Promise<string>, sleepImpl?: (ms: number) => Promise<void>, playwrightModule?: object }} [options]
   *   engine:      'cdp'（既定、追加パッケージ不要）または 'playwright'（playwright-core が必要）
   *   cacheDir:       取得結果のキャッシュ置き場（null でキャッシュしない）
   *   profileDir:     ブラウザのプロファイル置き場（Cookie を保持して確認ページを減らす）。既定: <profileBaseDir or cacheDir or tmp>/npmsite-browser-profile[-playwright]
   *   profileBaseDir: cacheDir が null（結果キャッシュ無効）でもプロファイルは残したいときの置き場
   *   waitMs:      取得ごとの待ち時間の範囲（ミリ秒）。{ min: 0, max: 0 } で待たない
   *   onWait:      待ちに入るときに呼ばれる（ログ用）
   *   dumpDomImpl: 渡すとブラウザを起動せずにその関数で HTML を得る（テスト用）
   */
  constructor(options = {}) {
    this.cacheDir = options.cacheDir ?? null;
    this.browserPath = options.browserPath ?? null;
    this.engine = normalizeEngine(options.engine);
    this.profileDir =
      options.profileDir ??
      path.join(
        options.profileBaseDir ?? this.cacheDir ?? os.tmpdir(),
        this.engine === 'playwright' ? 'npmsite-browser-profile-playwright' : 'npmsite-browser-profile',
      );
    this.timeoutMs = options.timeoutMs ?? 45000;
    this.waitMs = normalizeWait(options.waitMs);
    this.onWait = options.onWait ?? null;
    this.dumpDomImpl = options.dumpDomImpl ?? null;
    this.playwrightModule = options.playwrightModule ?? null;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.limiter = createLimiter(options.concurrency ?? 1);
    this.stats = { requests: 0, cacheHits: 0, waitedMs: 0 };
    this.sessionPromise = null;
  }

  /** ブラウザセッションを（初回だけ）起動する。 */
  async session() {
    this.sessionPromise ??= (async () => {
      const browser = this.browserPath ?? (await findBrowser());
      if (!browser) {
        throw new Error('Edge / Chrome が見つかりません。設定「ブラウザ」または環境変数 NLD_BROWSER に実行ファイルのパスを指定してください');
      }
      const s =
        this.engine === 'playwright'
          ? new PlaywrightSession(browser, this.profileDir, { playwrightModule: this.playwrightModule })
          : new BrowserSession(browser, this.profileDir);
      await s.start();
      return s;
    })();
    return this.sessionPromise;
  }

  /** 待ち時間をランダムに決めて待つ。 */
  async wait(name, version) {
    const { min, max } = this.waitMs;
    if (max <= 0) return 0;
    const waitMs = Math.round(min + Math.random() * (max - min));
    if (waitMs <= 0) return 0;
    this.onWait?.({ name, version, waitMs });
    await this.sleepImpl(waitMs);
    this.stats.waitedMs += waitMs;
    return waitMs;
  }

  /**
   * @returns {Promise<{ ok: true, url: string, names: string[], count: number|null } | { ok: false, url: string, error: string }>}
   */
  async fetchDependencies(name, version) {
    const url = siteUrl(name, version);
    const cacheFile = `${safeFileName(name)}@${version}.npmsite.json`;
    const cached = await readJsonCache(this.cacheDir, cacheFile);
    if (cached && Array.isArray(cached.names)) {
      this.stats.cacheHits += 1;
      return { ok: true, url, names: cached.names, count: cached.count ?? cached.names.length };
    }
    try {
      const fetchOnce = () =>
        this.limiter(async () => {
          await this.wait(name, version);
          this.stats.requests += 1;
          if (this.dumpDomImpl) return this.dumpDomImpl(url);
          const s = await this.session();
          return s.fetchHtml(url, { timeoutMs: this.timeoutMs });
        });
      let html;
      try {
        html = await fetchOnce();
      } catch (err) {
        // 確認ページ (Cloudflare) で止まった場合だけ、長めに待ってもう一度だけ試す
        if (!/確認ページ/.test(err.message)) throw err;
        const retryWaitMs = Math.max(this.waitMs.max, CHALLENGE_RETRY_WAIT_MS);
        this.onWait?.({ name, version, waitMs: retryWaitMs, reason: 'challenge' });
        await this.sleepImpl(retryWaitMs);
        this.stats.waitedMs += retryWaitMs;
        this.stats.challengeRetries = (this.stats.challengeRetries ?? 0) + 1;
        html = await fetchOnce();
      }
      const { names, count } = parseDependencies(html);
      await writeJsonCache(this.cacheDir, cacheFile, { names, count, fetchedAt: new Date().toISOString() });
      return { ok: true, url, names, count };
    } catch (err) {
      return { ok: false, url, error: err.message };
    }
  }

  /** ブラウザを終了する。起動していなければ何もしない。 */
  async close() {
    if (!this.sessionPromise) return;
    const p = this.sessionPromise;
    this.sessionPromise = null;
    try {
      const s = await p;
      await s.close();
    } catch {
      // 起動に失敗していた場合は何もしない
    }
  }
}
