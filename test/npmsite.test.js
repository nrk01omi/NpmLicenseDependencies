import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { NpmSiteClient, normalizeWait, parseDependencies, siteUrl } from '../src/npmsite.js';

/** npmjs.com の Dependencies タブの DOM を模した HTML（実ページの構造に合わせている） */
const PAGE = `<!DOCTYPE html><html><head><title>amqplib - npm</title></head><body>
<h2 class="x">Dependencies (<!-- -->4<!-- -->)</h2>
<ul class="list pl0" aria-label="Dependencies">
  <li class="dib mr2"><a href="/package/%40acuminous%2Fbitsyntax" class="y">@acuminous/bitsyntax</a></li>
  <li class="dib mr2"><a href="/package/url-parse" class="y">url-parse</a></li>
  <li class="dib mr2"><a href="/package/buffer-more-ints" class="y">buffer-more-ints</a></li>
  <li class="dib mr2"><a href="/package/readable-stream" class="y">readable-stream</a></li>
</ul>
<h2 class="x">Dev Dependencies (<!-- -->2<!-- -->)</h2>
<ul class="list pl0" aria-label="Dev Dependencies">
  <li class="dib mr2"><a href="/package/mocha" class="y">mocha</a></li>
  <li class="dib mr2"><a href="/package/nyc" class="y">nyc</a></li>
</ul>
</body></html>`;

test('siteUrl: バージョン指定の Dependencies タブ URL を作る（スコープ付きはエンコード）', () => {
  assert.equal(siteUrl('amqplib', '0.10.3'), 'https://www.npmjs.com/package/amqplib/v/0.10.3?activeTab=dependencies');
  assert.equal(siteUrl('@scope/pkg', '1.0.0'), 'https://www.npmjs.com/package/@scope/pkg/v/1.0.0?activeTab=dependencies');
});

test('parseDependencies: Dependencies 欄の名前だけを名前順に取り出し、Dev Dependencies は含めない', () => {
  const { names, count } = parseDependencies(PAGE);
  assert.deepEqual(names, ['@acuminous/bitsyntax', 'buffer-more-ints', 'readable-stream', 'url-parse']);
  assert.equal(count, 4);
});

test('parseDependencies: Cloudflare のブロックページはエラーにする', () => {
  assert.throws(
    () => parseDependencies('<html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>'),
    /Cloudflare/,
  );
});

test('parseDependencies: Dependencies 欄が無いページはエラーにする', () => {
  assert.throws(() => parseDependencies('<html><head><title>npm</title></head><body>nothing</body></html>'), /Dependencies 欄が見つかりません/);
});

test('normalizeWait: 既定は 1〜3 秒、min > max は入れ替え、不正値は既定にする', () => {
  assert.deepEqual(normalizeWait(undefined), { min: 1000, max: 3000 });
  assert.deepEqual(normalizeWait({ min: 5000, max: 2000 }), { min: 2000, max: 5000 });
  assert.deepEqual(normalizeWait({ min: 'x', max: 500 }), { min: 500, max: 1000 });
  assert.deepEqual(normalizeWait({ min: 0, max: 0 }), { min: 0, max: 0 });
});

test('NpmSiteClient: 取得前に範囲内の待ち時間を入れ、キャッシュ無しなら毎回取得する', async () => {
  const waits = [];
  const urls = [];
  const client = new NpmSiteClient({
    cacheDir: null,
    waitMs: { min: 200, max: 400 },
    onWait: (ev) => waits.push(ev),
    sleepImpl: async () => {},
    dumpDomImpl: async (url) => {
      urls.push(url);
      return PAGE;
    },
  });
  const r1 = await client.fetchDependencies('amqplib', '0.10.3');
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.names, ['@acuminous/bitsyntax', 'buffer-more-ints', 'readable-stream', 'url-parse']);
  assert.equal(r1.url, siteUrl('amqplib', '0.10.3'));
  assert.equal(waits.length, 1);
  assert.equal(waits[0].name, 'amqplib');
  assert.ok(waits[0].waitMs >= 200 && waits[0].waitMs <= 400, `待ち時間が範囲外: ${waits[0].waitMs}`);
  assert.equal(client.stats.requests, 1);
  assert.equal(client.stats.waitedMs, waits[0].waitMs);
  assert.deepEqual(urls, [siteUrl('amqplib', '0.10.3')]);
});

test('NpmSiteClient: Cloudflare の確認ページで止まったら長めに待って 1 回だけ再試行する', async () => {
  const waits = [];
  let calls = 0;
  const client = new NpmSiteClient({
    cacheDir: null,
    waitMs: { min: 0, max: 0 },
    onWait: (ev) => waits.push(ev),
    sleepImpl: async () => {},
    dumpDomImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('npm サイトの確認ページ (Cloudflare) から先に進めませんでした (45 秒)');
      return PAGE;
    },
  });
  const r = await client.fetchDependencies('amqplib', '0.10.3');
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
  assert.equal(client.stats.requests, 2);
  assert.equal(client.stats.challengeRetries, 1);
  assert.deepEqual(waits.map((w) => w.reason), ['challenge']);
  assert.ok(waits[0].waitMs >= 15000);

  // 2 回目も確認ページなら諦める（3 回目は試さない）
  calls = 0;
  const stubborn = new NpmSiteClient({
    cacheDir: null,
    waitMs: { min: 0, max: 0 },
    sleepImpl: async () => {},
    dumpDomImpl: async () => {
      calls += 1;
      throw new Error('npm サイトの確認ページ (Cloudflare) から先に進めませんでした (45 秒)');
    },
  });
  const r2 = await stubborn.fetchDependencies('amqplib', '0.10.3');
  assert.equal(r2.ok, false);
  assert.equal(calls, 2);
  assert.match(r2.error, /確認ページ/);
});

test('NpmSiteClient: 待ち時間 0 なら待たず、取得失敗は ok=false で理由を返す（例外にしない）', async () => {
  const waits = [];
  const client = new NpmSiteClient({
    cacheDir: null,
    waitMs: { min: 0, max: 0 },
    onWait: (ev) => waits.push(ev),
    dumpDomImpl: async () => {
      throw new Error('ブラウザ起動失敗: ENOENT');
    },
  });
  const r = await client.fetchDependencies('amqplib', '0.10.3');
  assert.equal(r.ok, false);
  assert.match(r.error, /ブラウザ起動失敗/);
  assert.equal(waits.length, 0);
});

test('normalizeEngine: cdp / playwright 以外は cdp にする', async () => {
  const { normalizeEngine } = await import('../src/npmsite.js');
  assert.equal(normalizeEngine('playwright'), 'playwright');
  assert.equal(normalizeEngine('cdp'), 'cdp');
  assert.equal(normalizeEngine('foo'), 'cdp');
  assert.equal(normalizeEngine(undefined), 'cdp');
});

test('engine=playwright: launchPersistentContext でページを開き、同じポーリングで Dependencies 欄を取り出す', async () => {
  const calls = { launch: [], goto: [], closedPages: 0, closedContext: 0 };
  let html = '<html><head><title>x</title></head><body>loading</body></html>';
  const fakePage = {
    goto: async (url, opts) => { calls.goto.push({ url, opts }); html = PAGE; },
    evaluate: async () => 'complete',
    content: async () => html,
    close: async () => { calls.closedPages += 1; },
  };
  const fakeModule = {
    chromium: {
      launchPersistentContext: async (dir, opts) => {
        calls.launch.push({ dir, opts });
        return { newPage: async () => fakePage, close: async () => { calls.closedContext += 1; } };
      },
    },
  };
  const client = new NpmSiteClient({
    cacheDir: null,
    engine: 'playwright',
    browserPath: 'C:/fake/msedge.exe',
    profileDir: path.join(os.tmpdir(), 'nld-test-profile'),
    waitMs: { min: 0, max: 0 },
    playwrightModule: fakeModule,
  });
  const r = await client.fetchDependencies('amqplib', '0.10.3');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.names, ['@acuminous/bitsyntax', 'buffer-more-ints', 'readable-stream', 'url-parse']);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].dir, path.join(os.tmpdir(), 'nld-test-profile'));
  assert.equal(calls.launch[0].opts.executablePath, 'C:/fake/msedge.exe');
  assert.equal(calls.launch[0].opts.headless, true);
  assert.equal(calls.goto[0].url, siteUrl('amqplib', '0.10.3'));
  assert.equal(calls.closedPages, 1);
  await client.close();
  assert.equal(calls.closedContext, 1);
});

test('engine=playwright: playwright-core が無ければ、インストール方法を含むエラーを ok=false で返す', async () => {
  const { PlaywrightSession } = await import('../src/npmsite.js');
  // このリポジトリには playwright を入れていない前提。入っている環境ではスキップ
  let installed = true;
  try { await import('playwright-core'); } catch { installed = false; }
  if (installed) return;
  await assert.rejects(() => PlaywrightSession.loadModule(), /npm install playwright-core/);
  const client = new NpmSiteClient({ cacheDir: null, engine: 'playwright', browserPath: 'C:/fake/msedge.exe', waitMs: { min: 0, max: 0 } });
  const r = await client.fetchDependencies('amqplib', '0.10.3');
  assert.equal(r.ok, false);
  assert.match(r.error, /npm install playwright-core/);
});
