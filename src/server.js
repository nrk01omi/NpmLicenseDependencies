#!/usr/bin/env node
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { analyze, buildRow, rowToCells, CSV_HEADER } from './analyze.js';
import { RegistryClient } from './registry.js';
import { toCsv } from './csv.js';
import { pickFolder, pickSaveCsv } from './dialogs.js';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(TOOL_ROOT, '.cache');
const PUBLIC_DIR = path.join(TOOL_ROOT, 'public');

/** 画面に配信する実行状態（サーバーにつき 1 ジョブ） */
const state = {
  status: 'idle', // idle | running | done | error
  project: '',
  out: '',
  includeDev: false,
  useCache: true,
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
  errorPolicy: 'ask', // ask | auto | ignore  （実行開始時の設定。ダイアログの選択で変わる）
  autoRetries: 3, // auto のときの最大リトライ回数
  pending: null, // 確認待ちのエラー { index, name, version, message, attempt }
};
/** 再取得に必要な内部情報（画面には送らない） */
let context = { projectInfo: null, deps: [], pendingResolve: null, askChain: Promise.resolve() };
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
  await writeFile(state.out, toCsv(CSV_HEADER, state.rows.filter(Boolean).map(rowToCells)), 'utf8');
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
    errorPolicy: ['ask', 'auto', 'ignore'].includes(params.errorPolicy) ? params.errorPolicy : 'ask',
    autoRetries: clampInt(params.autoRetries, 1, 10, 3),
    pending: null,
  });
  context = { projectInfo: null, deps: [], pendingResolve: null, askChain: Promise.resolve() };
  log(`解析開始: ${state.project}`);
  log(`参照バージョン: ${state.versionMode === 'latest' ? 'npm の最新版 (npm サイトの表示と同じ)' : 'インストール済み (package-lock / node_modules)'}`);
  log(`エラー時の動作: ${{ ask: '確認ダイアログを表示', auto: `自動リトライ (最大 ${state.autoRetries} 回)`, ignore: '失敗のまま次へ' }[state.errorPolicy]}`);
  broadcast();

  // 応答はすぐ返し、解析はバックグラウンドで進める
  (async () => {
    try {
      const result = await analyze({
        projectDir: state.project,
        includeDev: state.includeDev,
        cacheDir: state.useCache ? CACHE_DIR : null,
        registryUrl: state.registry || undefined,
        versionMode: state.versionMode,
        onStart: ({ project, deps }) => {
          Object.assign(context, { projectInfo: project, deps });
          state.total = deps.length;
          state.rows = new Array(deps.length).fill(null);
          log(`直接依存 ${deps.length} 件 (package-lock: ${project.lock ? 'あり' : 'なし'})`);
          broadcast();
        },
        onProgress: ({ index, row, completed, total }) => {
          state.rows[index] = row;
          state.completed = completed;
          log(`${row.ok ? 'OK' : 'NG'}  ${row.name}@${row.version}  ${row.ok ? row.license : row.note}`);
          if (completed === total || completed % 5 === 0) broadcast();
        },
        onError: handleFetchError,
      });
      state.stats = result.stats;
      state.status = 'done';
      state.finishedAt = new Date().toISOString();
      log(`完了: ${result.rows.length} 件 (NG ${failedCount()} 件, レジストリ要求 ${result.stats.requests} 回, キャッシュ ${result.stats.cacheHits} 件)`);
      await saveCsv().catch((err) => log(`CSV 保存に失敗: ${err.message}`));
    } catch (err) {
      state.status = 'error';
      state.error = err.message;
      state.finishedAt = new Date().toISOString();
      log(`エラー: ${err.message}`);
    }
    state.pending = null;
    context.pendingResolve = null;
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

function resolvePendingError(action) {
  if (!state.pending || !context.pendingResolve) throw new HttpError(409, '確認待ちのエラーはありません');
  if (!['retry', 'auto', 'ignore', 'ignore-all'].includes(action)) throw new HttpError(400, `不明な操作です: ${action}`);
  const resolve = context.pendingResolve;
  context.pendingResolve = null;
  resolve(action);
  broadcast();
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function retryRows(indices) {
  if (state.status === 'running') throw new HttpError(409, '実行中は再取得できません');
  if (!context.projectInfo) throw new HttpError(400, '先に解析を実行してください');
  const targets = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < state.rows.length);
  if (targets.length === 0) throw new HttpError(400, '再取得対象がありません');

  state.retrying = targets;
  log(`再取得開始: ${targets.map((i) => context.deps[i].name).join(', ')}`);
  broadcast();

  // 再取得はキャッシュを読まず、常にレジストリへ問い合わせる
  const client = new RegistryClient({ registryUrl: state.registry || undefined, cacheDir: null });
  await Promise.all(
    targets.map(async (i) => {
      const row = await buildRow(context.deps[i], context.projectInfo, client, { versionMode: state.versionMode });
      state.rows[i] = row;
      log(`${row.ok ? 'OK' : 'NG'}  ${row.name}@${row.version}  ${row.ok ? row.license : row.note}`);
    }),
  );
  state.retrying = [];
  log(`再取得完了: NG 残り ${failedCount()} 件`);
  await saveCsv().catch((err) => log(`CSV 保存に失敗: ${err.message}`));
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
    const indices = body.all ? state.rows.map((r, i) => (r && !r.ok ? i : -1)).filter((i) => i >= 0) : body.indices ?? [];
    await retryRows(indices);
    return sendJson(res, 200, { ok: true, failed: failedCount() });
  }

  if (route === 'POST /api/error-decision') {
    const body = await readJsonBody(req);
    resolvePendingError(String(body.action ?? ''));
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/save') {
    const body = await readJsonBody(req);
    if (body.out) state.out = path.resolve(String(body.out));
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
