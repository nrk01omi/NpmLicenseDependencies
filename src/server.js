#!/usr/bin/env node
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { analyze, buildRow, rowToCells, rowsFromCsv, orderRows, normalizeOrder, CSV_HEADER, MATCH, DEP_TYPE_TRANSITIVE } from './analyze.js';
import { RegistryClient } from './registry.js';
import { NpmSiteClient, DEFAULT_WAIT_MS, normalizeEngine } from './npmsite.js';
import { VulnClient, attachVulnerabilities } from './vulns.js';
import { toCsv } from './csv.js';
import { pickFolder, pickSaveCsv, pickOpenCsv } from './dialogs.js';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(TOOL_ROOT, '.cache');
const PUBLIC_DIR = path.join(TOOL_ROOT, 'public');

/** 画面に配信する実行状態（サーバーにつき 1 ジョブ） */
const state = {
  status: 'idle', // idle | running | done | error
  project: '',
  out: '',
  includeDev: false,
  useCache: true, // レジストリ応答のキャッシュ
  useSiteCache: true, // npm サイト応答のキャッシュ
  registry: '',
  total: 0,
  completed: 0,
  rows: [],
  log: [],
  error: null,
  startedAt: null,
  finishedAt: null,
  savedAt: null,
  stats: null,
  retrying: [], // 再取得中の行 index
  versionMode: 'installed', // installed | latest
  useSite: true, // npm サイトの Dependencies 欄も取得して照合する
  siteWait: { min: DEFAULT_WAIT_MS.min / 1000, max: DEFAULT_WAIT_MS.max / 1000 }, // サイト取得ごとの待ち時間（秒、ランダム）
  browser: '', // サイト取得に使うブラウザの実行ファイル（空なら自動検出）
  siteEngine: 'cdp', // cdp（内蔵）| playwright（要 playwright-core）
  recursive: false, // 依存ライブラリを再帰的にたどる
  order: 'tree', // CSV の並び順: tree（親子順）| depth（深さ順）
  useVulns: true, // ⑥ 脆弱性チェック（npm advisories API）
  vulnStats: null, // ⑥ の集計 { checked, withVulns, advisories, error }
  source: 'analyze', // 結果の出どころ: analyze（解析）| csv（保存した CSV の読み込み。再取得は不可）
  loadedFrom: '', // csv のとき読み込んだファイル
  phase: 'idle', // idle | discover（再帰調査中）| confirm（件数確認待ち）| analyze（本調査中）
  discovery: null, // 再帰調査の進捗 { processed, total }
  discoverySummary: null, // 再帰調査の集計（件数確認ダイアログと結果表示に使う）
  pendingRecursive: null, // 件数確認待ちなら summary
  errorPolicy: 'ask', // ask | auto | ignore  （実行開始時の設定。ダイアログの選択で変わる）
  autoRetries: 3, // auto のときの最大リトライ回数
  pending: null, // 確認待ちのエラー { index, name, version, message, attempt }
};
/** 再取得に必要な内部情報（画面には送らない） */
let context = { projectInfo: null, deps: [], pendingResolve: null, recursiveResolve: null, askChain: Promise.resolve() };
const sseClients = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- state helpers

function log(message) {
  const line = `${new Date().toLocaleTimeString('ja-JP')}  ${message}`;
  state.log.push(line);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  process.stderr.write(line + '\n');
}

function broadcast() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function failedCount() {
  return state.rows.filter((r) => r && !r.ok).length;
}

async function saveCsv() {
  if (!state.out) throw new Error('出力先が指定されていません');
  await mkdir(path.dirname(state.out), { recursive: true });
  await writeFile(state.out, toCsv(CSV_HEADER, orderRows(state.rows, state.order).filter(Boolean).map(rowToCells)), 'utf8');
  state.savedAt = new Date().toISOString();
  log(`CSV を保存しました: ${state.out}`);
}

// ---------------------------------------------------------------- job control

async function startJob(params) {
  if (state.status === 'running') throw new HttpError(409, '実行中です。完了までお待ちください。');
  const projectDir = String(params.project ?? '').trim();
  if (!projectDir) throw new HttpError(400, 'プロジェクトフォルダを指定してください');

  Object.assign(state, {
    status: 'running',
    project: path.resolve(projectDir),
    out: params.out ? path.resolve(String(params.out)) : path.join(path.resolve(projectDir), 'npm-dependencies.csv'),
    includeDev: Boolean(params.includeDev),
    useCache: params.useCache !== false,
    useSiteCache: params.useSiteCache !== false,
    registry: String(params.registry ?? '').trim(),
    total: 0,
    completed: 0,
    rows: [],
    log: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    savedAt: null,
    stats: null,
    retrying: [],
    versionMode: params.versionMode === 'latest' ? 'latest' : 'installed',
    useSite: params.useSite !== false,
    siteWait: normalizeSiteWait(params.siteWait),
    browser: String(params.browser ?? '').trim(),
    siteEngine: normalizeEngine(params.siteEngine),
    recursive: Boolean(params.recursive),
    order: normalizeOrder(params.order),
    useVulns: params.useVulns !== false,
    vulnStats: null,
    source: 'analyze',
    loadedFrom: '',
    phase: params.recursive ? 'discover' : 'analyze',
    discovery: null,
    discoverySummary: null,
    pendingRecursive: null,
    errorPolicy: ['ask', 'auto', 'ignore'].includes(params.errorPolicy) ? params.errorPolicy : 'ask',
    autoRetries: clampInt(params.autoRetries, 1, 10, 3),
    pending: null,
  });
  context = { projectInfo: null, deps: [], pendingResolve: null, recursiveResolve: null, askChain: Promise.resolve() };
  log(`解析開始: ${state.project}`);
  log(state.recursive ? '⑤ 再帰調査: あり（依存ライブラリをたどって推移的依存を列挙し、件数を確認してから本調査）' : '⑤ 再帰調査: なし（直接依存のみ）');
  log(state.useVulns ? '⑥ 脆弱性チェック: あり（npm advisories API、本調査の後にまとめて確認）' : '⑥ 脆弱性チェック: なし');
  log(`参照バージョン: ${state.versionMode === 'latest' ? 'npm の最新版 (npm サイトの表示と同じ)' : 'インストール済み (package-lock / node_modules)'}`);
  log(`エラー時の動作: ${{ ask: '確認ダイアログを表示', auto: `自動リトライ (最大 ${state.autoRetries} 回)`, ignore: '失敗のまま次へ' }[state.errorPolicy]}`);
  log(
    state.useSite
      ? `npm サイト照合: あり (方法: ${state.siteEngine === 'playwright' ? 'Playwright' : '内蔵 DevTools'}, キャッシュ: ${state.useSiteCache ? '使う' : '使わない'}, 取得ごとに ${state.siteWait.min}～${state.siteWait.max} 秒待機, ブラウザ: ${state.browser || '自動検出'})`
      : 'npm サイト照合: なし',
  );
  broadcast();

  // 応答はすぐ返し、解析はバックグラウンドで進める
  (async () => {
    try {
      const result = await analyze({
        projectDir: state.project,
        includeDev: state.includeDev,
        cacheDir: state.useCache ? CACHE_DIR : null,
        siteCacheDir: state.useSiteCache ? CACHE_DIR : null,
        profileBaseDir: CACHE_DIR,
        registryUrl: state.registry || undefined,
        versionMode: state.versionMode,
        useSite: state.useSite,
        browserPath: state.browser || null,
        siteWaitMs: siteWaitMs(),
        siteEngine: state.siteEngine,
        recursive: state.recursive,
        useVulns: state.useVulns,
        onVulns: (v) => {
          state.vulnStats = v;
          log(
            v.error
              ? `⑥ 脆弱性チェック: 失敗 (${v.error})`
              : `⑥ 脆弱性チェック: 確認 ${v.checked} 件, 脆弱性あり ${v.withVulns} 件 (advisory 合計 ${v.advisories} 件)`,
          );
          broadcast();
        },
        onSiteWait: logSiteWait,
        onStart: ({ project, deps }) => {
          Object.assign(context, { projectInfo: project, deps });
          log(`直接依存 ${deps.length} 件 (package-lock: ${project.lock ? 'あり' : 'なし'})`);
          if (state.recursive) log('再帰調査を開始します…');
          broadcast();
        },
        onDiscoverProgress: ({ processed, total }) => {
          state.discovery = { processed, total };
          if (processed % 10 === 0 || processed === total) broadcast();
        },
        onDiscovered: async ({ summary }) => {
          state.discoverySummary = summary;
          state.phase = 'confirm';
          state.pendingRecursive = summary;
          log(
            `再帰調査 完了: 合計 ${summary.total} 件 (直接 ${summary.direct} 件, 推移的 ${summary.transitive} 件, 最大深さ ${summary.maxDepth}, lock で決定 ${summary.fromLock} 件, 解決不能 ${summary.unresolved} 件, 取得失敗 ${summary.failed} 件)`,
          );
          log('件数を確認して「本調査を開始」を押してください（確認待ち）');
          broadcast();
          const proceed = await new Promise((resolve) => {
            context.recursiveResolve = resolve;
          });
          state.pendingRecursive = null;
          context.recursiveResolve = null;
          state.phase = proceed ? 'analyze' : 'idle';
          log(proceed ? '利用者の選択: 本調査を開始' : '利用者の選択: 本調査を中止（再帰調査の結果のみ）');
          broadcast();
          return proceed;
        },
        onTargets: ({ targets }) => {
          context.deps = targets;
          state.total = targets.length;
          state.rows = new Array(targets.length).fill(null);
          log(`本調査: ${targets.length} 件を処理します`);
          broadcast();
        },
        onProgress: ({ index, row, completed, total }) => {
          state.rows[index] = row;
          state.completed = completed;
          log(describeRow(row));
          broadcast();
        },
        onError: handleFetchError,
      });
      state.stats = result.stats;
      state.status = 'done';
      state.phase = 'idle';
      state.finishedAt = new Date().toISOString();
      if (result.aborted) {
        log('本調査を中止しました（CSV は保存していません）');
        broadcast();
        return;
      }
      log(`完了: ${result.rows.length} 件 (NG ${failedCount()} 件, レジストリ要求 ${result.stats.requests} 回, キャッシュ ${result.stats.cacheHits} 件)`);
      if (state.useSite) log(describeSiteSummary(result.rows, result.stats.site));
      await saveCsv().catch((err) => log(`CSV 保存に失敗: ${err.message}`));
    } catch (err) {
      state.status = 'error';
      state.phase = 'idle';
      state.error = err.message;
      state.finishedAt = new Date().toISOString();
      log(`エラー: ${err.message}`);
    }
    state.pending = null;
    state.pendingRecursive = null;
    context.pendingResolve = null;
    context.recursiveResolve = null;
    broadcast();
  })();
}

/**
 * 取得失敗時の判断。
 * - errorPolicy = 'ask'    : 画面にダイアログを出し、利用者の選択を待つ（1 件ずつ順番に）
 * - errorPolicy = 'auto'   : 確認せずに autoRetries 回までリトライし、それでも駄目なら失敗のまま次へ
 * - errorPolicy = 'ignore' : 確認せずに失敗のまま次へ
 */
async function handleFetchError({ index, dep, row, attempt }) {
  if (state.errorPolicy === 'ignore') return 'ignore';

  if (state.errorPolicy === 'auto') {
    if (attempt <= state.autoRetries) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      log(`自動リトライ ${attempt}/${state.autoRetries}: ${dep.name} (${wait / 1000} 秒後)`);
      await sleep(wait);
      return 'retry';
    }
    log(`自動リトライ上限に達したため失敗のまま次へ: ${dep.name}`);
    return 'ignore';
  }

  // 'ask': 並列で複数のエラーが起きても、ダイアログは 1 件ずつ順番に出す
  const turn = context.askChain.then(async () => {
    // 前の回答で方針が変わっていれば、聞かずにその方針に従う
    if (state.errorPolicy !== 'ask') return handleFetchError({ index, dep, row, attempt });

    state.pending = { index, name: dep.name, version: row.version, message: row.note, attempt };
    log(`確認待ち: ${dep.name} — ${row.note}`);
    broadcast();
    const action = await new Promise((resolve) => {
      context.pendingResolve = resolve;
    });
    state.pending = null;
    context.pendingResolve = null;

    switch (action) {
      case 'retry':
        log(`利用者の選択: 1 回リトライ (${dep.name})`);
        return 'retry';
      case 'auto':
        state.errorPolicy = 'auto';
        log(`利用者の選択: 以降は確認せず自動リトライ (最大 ${state.autoRetries} 回)`);
        return 'retry';
      case 'ignore-all':
        state.errorPolicy = 'ignore';
        log(`利用者の選択: 以降の失敗はすべて無視して続行`);
        return 'ignore';
      default:
        log(`利用者の選択: 失敗のまま次へ (${dep.name})`);
        return 'ignore';
    }
  });
  context.askChain = turn.catch(() => {});
  return turn;
}

function resolvePendingRecursive(action) {
  if (!state.pendingRecursive || !context.recursiveResolve) throw new HttpError(409, '件数確認待ちではありません');
  if (!['start', 'cancel'].includes(action)) throw new HttpError(400, `不明な操作です: ${action}`);
  const resolve = context.recursiveResolve;
  context.recursiveResolve = null;
  resolve(action === 'start');
}

function resolvePendingError(action) {
  if (!state.pending || !context.pendingResolve) throw new HttpError(409, '確認待ちのエラーはありません');
  if (!['retry', 'auto', 'ignore', 'ignore-all'].includes(action)) throw new HttpError(400, `不明な操作です: ${action}`);
  const resolve = context.pendingResolve;
  context.pendingResolve = null;
  resolve(action);
  broadcast();
}

/** 1 行分のログ文字列。 */
function describeRow(row) {
  const kind = row.depType === DEP_TYPE_TRANSITIVE ? ` (深さ ${row.depth})` : '';
  if (!row.ok) return `NG  ${row.name}@${row.version}${kind}  ${row.note}`;
  return `OK  ${row.name}@${row.version}${kind}  ${row.license}${row.match ? `  ${row.match}` : ''}`;
}

/** npm サイト照合の集計ログ。 */
function describeSiteSummary(rows, siteStats) {
  const count = (m) => rows.filter((r) => r && r.match === m).length;
  const s = siteStats ?? {};
  return `npm サイト照合: ${MATCH.ALL} ${count(MATCH.ALL)} 件, ${MATCH.MISMATCH} ${count(MATCH.MISMATCH)} 件, ${MATCH.UNKNOWN} ${count(MATCH.UNKNOWN)} 件 (サイト取得 ${s.requests ?? 0} 回, キャッシュ ${s.cacheHits ?? 0} 件, 待ち合計 ${((s.waitedMs ?? 0) / 1000).toFixed(1)} 秒)`;
}

function logSiteWait({ name, version, waitMs, reason }) {
  if (reason === 'challenge') log(`npm サイトの確認ページ (Cloudflare) が出たため ${(waitMs / 1000).toFixed(0)} 秒待って再試行: ${name}@${version}`);
  else log(`npm サイト取得まで ${(waitMs / 1000).toFixed(1)} 秒待機: ${name}@${version}`);
  broadcast();
}

/** 画面から来た待ち時間（秒）を { min, max } に正規化する。 */
function normalizeSiteWait(value) {
  const def = { min: DEFAULT_WAIT_MS.min / 1000, max: DEFAULT_WAIT_MS.max / 1000 };
  const toSec = (v, fallback) => (Number.isFinite(Number(v)) ? Math.min(600, Math.max(0, Number(v))) : fallback);
  const a = toSec(value?.min, def.min);
  const b = toSec(value?.max, def.max);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function siteWaitMs() {
  return { min: state.siteWait.min * 1000, max: state.siteWait.max * 1000 };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function retryRows(indices) {
  if (state.status === 'running') throw new HttpError(409, '実行中は再取得できません');
  if (state.source === 'csv') throw new HttpError(400, 'CSV から読み込んだ結果は再取得できません。同じプロジェクトで「実行」してください');
  if (!context.projectInfo) throw new HttpError(400, '先に解析を実行してください');
  const targets = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < state.rows.length);
  if (targets.length === 0) throw new HttpError(400, '再取得対象がありません');

  state.retrying = targets;
  log(`再取得開始: ${targets.map((i) => context.deps[i].name).join(', ')}`);
  broadcast();
  try {
    await retryRowsInner(targets);
  } catch (err) {
    state.retrying = [];
    broadcast();
    throw err;
  }
}

async function retryRowsInner(targets) {

  // 再取得はキャッシュを読まず、常にレジストリ（と npm サイト）へ問い合わせる
  const client = new RegistryClient({ registryUrl: state.registry || undefined, cacheDir: null });
  const site = state.useSite
    ? new NpmSiteClient({ cacheDir: null, profileBaseDir: CACHE_DIR, browserPath: state.browser || null, waitMs: siteWaitMs(), onWait: logSiteWait, engine: state.siteEngine })
    : null;
  try {
    await Promise.all(
      targets.map(async (i) => {
        const row = await buildRow(context.deps[i], context.projectInfo, client, { versionMode: state.versionMode, site });
        state.rows[i] = row;
        log(describeRow(row));
        broadcast();
      }),
    );
  } finally {
    await site?.close();
  }
  if (state.useVulns) {
    const v = await attachVulnerabilities(targets.map((i) => state.rows[i]), new VulnClient({ registryUrl: state.registry || undefined }));
    if (v.error) log(`⑥ 脆弱性チェック (再取得分): 失敗 (${v.error})`);
    else log(`⑥ 脆弱性チェック (再取得分): 確認 ${v.checked} 件, 脆弱性あり ${v.withVulns} 件`);
  }
  state.retrying = [];
  log(`再取得完了: NG 残り ${failedCount()} 件`);
  await saveCsv().catch((err) => log(`CSV 保存に失敗: ${err.message}`));
  broadcast();
}

// ---------------------------------------------------------------- CSV の読み込み

/**
 * 保存済みの CSV を読み込んで結果表に表示する。解析結果と同じ形に復元するが、
 * 元プロジェクトの情報は無いので「再取得」はできない（source = 'csv'）。
 */
async function loadCsvFile(filePath) {
  if (state.status === 'running') throw new HttpError(409, '実行中は読み込めません。完了までお待ちください。');
  const p = filePath.trim();
  if (!p) throw new HttpError(400, 'CSV ファイルを指定してください');
  const resolved = path.resolve(p);
  let text;
  let info;
  try {
    text = await readFile(resolved, 'utf8');
    info = await stat(resolved);
  } catch (err) {
    throw new HttpError(400, `CSV を読み込めません: ${err.message}`);
  }
  let parsed;
  try {
    parsed = rowsFromCsv(text);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  Object.assign(state, {
    status: 'done',
    phase: 'idle',
    source: 'csv',
    loadedFrom: resolved,
    project: '',
    out: resolved,
    total: parsed.rows.length,
    completed: parsed.rows.length,
    rows: parsed.rows,
    log: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    savedAt: info.mtime.toISOString(),
    stats: null,
    retrying: [],
    recursive: parsed.rows.some((r) => r.depth > 0),
    useSite: parsed.rows.some((r) => r.siteStatus !== 'skipped'),
    useVulns: parsed.rows.some((r) => r.vulnStatus !== 'skipped'),
    discovery: null,
    discoverySummary: null,
    pendingRecursive: null,
    vulnStats: null,
    pending: null,
  });
  context = { projectInfo: null, deps: [], pendingResolve: null, recursiveResolve: null, askChain: Promise.resolve() };
  log(`CSV を読み込みました: ${resolved} (${parsed.rows.length} 件, 保存日時 ${info.mtime.toLocaleString('ja-JP')})`);
  if (parsed.missing.length) log(`この CSV に無い列: ${parsed.missing.join(', ')}（古い形式。ある列だけ表示します）`);
  log('読み込んだ結果は「再取得」できません。更新するには同じプロジェクトで「実行」してください');
  broadcast();
}

// ---------------------------------------------------------------- http

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'リクエスト本文が JSON ではありません');
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /' || route === 'GET /index.html') {
    const html = await readFile(path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (route === 'GET /spec' || route === 'GET /spec.html') {
    const html = await readFile(path.join(PUBLIC_DIR, 'spec.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (route === 'GET /favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (route === 'GET /api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (route === 'GET /api/state') return sendJson(res, 200, state);

  if (route === 'POST /api/run') {
    await startJob(await readJsonBody(req));
    return sendJson(res, 202, { ok: true });
  }

  if (route === 'POST /api/retry') {
    const body = await readJsonBody(req);
    // 「すべて再取得」はレジストリ NG の行と、npm サイトだけ取得できなかった行を対象にする
    const indices = body.all
      ? state.rows.map((r, i) => (r && (!r.ok || r.siteStatus === 'error') ? i : -1)).filter((i) => i >= 0)
      : body.indices ?? [];
    await retryRows(indices);
    return sendJson(res, 200, { ok: true, failed: failedCount() });
  }

  if (route === 'POST /api/recursive-decision') {
    const body = await readJsonBody(req);
    resolvePendingRecursive(String(body.action ?? ''));
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/error-decision') {
    const body = await readJsonBody(req);
    resolvePendingError(String(body.action ?? ''));
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/save') {
    const body = await readJsonBody(req);
    if (body.out) state.out = path.resolve(String(body.out));
    if (body.order) state.order = normalizeOrder(body.order);
    if (state.rows.length === 0) throw new HttpError(400, '保存する結果がありません');
    await saveCsv();
    broadcast();
    return sendJson(res, 200, { ok: true, out: state.out });
  }

  if (route === 'POST /api/dialog/folder') {
    const body = await readJsonBody(req);
    const selected = await pickFolder(String(body.initial ?? ''));
    return sendJson(res, 200, { path: selected });
  }

  if (route === 'POST /api/dialog/save') {
    const body = await readJsonBody(req);
    const selected = await pickSaveCsv(String(body.initial ?? ''));
    return sendJson(res, 200, { path: selected });
  }

  if (route === 'POST /api/load') {
    const body = await readJsonBody(req);
    await loadCsvFile(String(body.path ?? ''));
    return sendJson(res, 200, { ok: true, rows: state.rows.length, loadedFrom: state.loadedFrom });
  }

  if (route === 'POST /api/dialog/open') {
    const body = await readJsonBody(req);
    const selected = await pickOpenCsv(String(body.initial ?? ''));
    return sendJson(res, 200, { path: selected });
  }

  if (route === 'POST /api/open') {
    // 出力先フォルダをエクスプローラーで開く（Windows のみ）
    if (!state.out) throw new HttpError(400, '出力先がありません');
    if (process.platform === 'win32') spawn('explorer.exe', ['/select,', state.out], { detached: true, stdio: 'ignore' }).unref();
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, `Not found: ${route}`);
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) process.stderr.write(`[server] ${err.stack ?? err.message}\n`);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    });
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: 'string', default: '3939' },
      'no-open': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const port = Number(values.port);
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`ポート ${port} は既に使用中です。起動済みのサーバーを終了するか、--port <別の番号> を指定してください。\n`);
    } else {
      process.stderr.write(`サーバーの起動に失敗しました: ${err.message}\n`);
    }
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    process.stderr.write(`npm-license-dependencies GUI: ${url}  (Ctrl+C で終了)\n`);
    if (!values['no-open']) openBrowser(url);
  });
}
