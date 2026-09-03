import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLockResolver } from '../src/project.js';
import { buildRow, discoverDependencies, summarizeNodes, DEP_TYPE_TRANSITIVE } from '../src/analyze.js';
import { RegistryClient } from '../src/registry.js';

const fixtureLock = JSON.parse(await readFile(new URL('./fixtures/package-lock.v3.json', import.meta.url), 'utf8'));

/** fetch を差し替えたレジストリクライアント（ネットワーク不要） */
function fakeClient(routes) {
  const fetchImpl = async (url) => {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const body = routes[pathname];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return new RegistryClient({ fetchImpl, cacheDir: null, retries: 0 });
}

// ---------------------------------------------------------------- createLockResolver

test('createLockResolver (v3): 親の直下にネストされた別バージョンを優先し、無ければトップレベルを返す', () => {
  const r = createLockResolver(fixtureLock);
  assert.equal(r.size, 5);
  // debug の下にネストされた ms は debug から引くとネスト側
  assert.deepEqual(r.resolve('ms', ['debug']), { version: '2.1.3', path: ['debug', 'ms'] });
  // トップレベルから引くと ms は無い（ネストは見ない）
  assert.equal(r.resolve('ms', []), null);
  // トップレベルにあるものは、どの親から引いても見つかる（祖先をさかのぼってトップレベルへ）
  assert.deepEqual(r.resolve('debug', ['express']), { version: '2.6.9', path: ['debug'] });
  assert.deepEqual(r.resolve('@scope/pkg', ['express', 'debug']), { version: '2.0.0', path: ['@scope/pkg'] });
  assert.equal(r.resolve('nothing', ['express']), null);
});

test('createLockResolver (v1): dependencies の入れ子をたどり、ネスト側を優先する', () => {
  const lock = {
    lockfileVersion: 1,
    dependencies: {
      winston: { version: '3.3.3', dependencies: { 'readable-stream': { version: '3.6.0' } } },
      'readable-stream': { version: '1.1.14' },
      amqplib: { version: '0.6.0' },
    },
  };
  const r = createLockResolver(lock);
  assert.equal(r.size, 4);
  assert.deepEqual(r.resolve('readable-stream', ['winston']), { version: '3.6.0', path: ['winston', 'readable-stream'] });
  assert.deepEqual(r.resolve('readable-stream', ['amqplib']), { version: '1.1.14', path: ['readable-stream'] });
  assert.deepEqual(r.resolve('readable-stream', []), { version: '1.1.14', path: ['readable-stream'] });
  assert.equal(r.resolve('bluebird', ['amqplib']), null);
});

test('createLockResolver: lock が無ければ何も解決しない', () => {
  const r = createLockResolver(null);
  assert.equal(r.size, 0);
  assert.equal(r.resolve('x', []), null);
});

// ---------------------------------------------------------------- buildRow と lock の解決順

test('buildRow: 取得済みライブラリは lock 上の位置を起点に Node の解決順で引く（ネスト側のバージョン）', async () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'p', version: '1.0.0' },
      'node_modules/winston': { version: '3.3.3' },
      'node_modules/winston/node_modules/readable-stream': { version: '3.6.0' },
      'node_modules/readable-stream': { version: '1.1.14' },
      'node_modules/amqplib': { version: '0.6.0' },
    },
  };
  const project = { root: 'Z:/x', lock, lockVersions: new Map([['winston', '3.3.3'], ['amqplib', '0.6.0'], ['readable-stream', '1.1.14']]), lockResolver: createLockResolver(lock) };
  const client = fakeClient({
    '/winston/3.3.3': { name: 'winston', version: '3.3.3', license: 'MIT', dependencies: { 'readable-stream': '^3.4.0' } },
    '/amqplib/0.6.0': { name: 'amqplib', version: '0.6.0', license: 'MIT', dependencies: { 'readable-stream': '1.x >=1.1.9' } },
  });
  const winston = await buildRow({ name: 'winston', range: '^3.3.3', depType: 'dependencies' }, project, client);
  assert.deepEqual(winston.dependenciesResolved, ['readable-stream@3.6.0']); // 以前はトップレベルの 1.1.14 を返していた
  const amqplib = await buildRow({ name: 'amqplib', range: '^0.6.0', depType: 'dependencies' }, project, client);
  assert.deepEqual(amqplib.dependenciesResolved, ['readable-stream@1.1.14']);
});

// ---------------------------------------------------------------- discoverDependencies

const ROUTES = {
  '/a/1.0.0': { name: 'a', version: '1.0.0', license: 'MIT', dependencies: { b: '^2.0.0', c: '^1.0.0' } },
  '/b/2.0.0': { name: 'b', version: '2.0.0', license: 'MIT', dependencies: { c: '^1.0.0', d: '^1.0.0' } },
  '/b/2.5.0': { name: 'b', version: '2.5.0', license: 'MIT', dependencies: { c: '^1.0.0' } },
  '/c/1.0.0': { name: 'c', version: '1.0.0', license: 'MIT', dependencies: {} },
  '/d/1.0.0': { name: 'd', version: '1.0.0', license: 'MIT', dependencies: { a: '^1.0.0' } }, // 循環 d → a
  '/b': { 'dist-tags': { latest: '2.5.0' }, versions: { '2.0.0': {}, '2.5.0': {}, '3.0.0': {} } },
  '/c': { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } },
  '/d': { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } },
};

test('discoverDependencies: lock があれば lock の位置で解決し、同じ name@version は 1 ノードにまとめ、循環で止まる', async () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'p', version: '1.0.0' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '2.0.0' },
      'node_modules/c': { version: '1.0.0' },
      'node_modules/d': { version: '1.0.0' },
    },
  };
  const project = { root: 'Z:/x', lock, lockVersions: new Map([['a', '1.0.0']]), lockResolver: createLockResolver(lock) };
  const client = fakeClient(ROUTES);
  const progress = [];
  const nodes = await discoverDependencies(project, [{ name: 'a', range: '^1.0.0', depType: 'dependencies' }], client, {
    onProgress: (ev) => progress.push(ev),
  });
  assert.deepEqual(
    nodes.map((n) => `${n.name}@${n.version}:${n.depth}`),
    ['a@1.0.0:0', 'b@2.0.0:1', 'c@1.0.0:1', 'd@1.0.0:2'],
  );
  const b = nodes.find((n) => n.name === 'b');
  assert.equal(b.depType, DEP_TYPE_TRANSITIVE);
  assert.deepEqual(b.parents, ['a@1.0.0']);
  assert.deepEqual(b.lockPath, ['b']);
  const c = nodes.find((n) => n.name === 'c');
  assert.deepEqual(c.parents.sort(), ['a@1.0.0', 'b@2.0.0']); // 2 つの親から要求される
  const a = nodes.find((n) => n.name === 'a');
  assert.deepEqual(a.parents, ['d@1.0.0']); // 循環: d が a を要求するが a は既存ノードなので親だけ追加
  assert.equal(a.depth, 0);
  assert.equal(progress.at(-1).processed, 4);
  const s = summarizeNodes(nodes);
  assert.deepEqual(s, { total: 4, direct: 1, transitive: 3, failed: 0, maxDepth: 2, unresolved: 0, fromLock: 4, lockOnly: 0 });
});

test('discoverDependencies: lock に無い子は範囲を満たす最大バージョンで解決し、備考に残す', async () => {
  const project = { root: 'Z:/x', lock: null, lockVersions: new Map(), lockResolver: createLockResolver(null) };
  const client = fakeClient({ ...ROUTES, '/a': { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } } });
  const nodes = await discoverDependencies(project, [{ name: 'a', range: '^1.0.0', depType: 'dependencies' }], client);
  const b = nodes.find((n) => n.name === 'b');
  assert.equal(b.version, '2.5.0'); // ^2.0.0 を満たす最大（3.0.0 は範囲外）
  assert.equal(b.lockPath, null);
  assert.match(b.note, /範囲解決/);
  // b@2.5.0 は d を要求しないので d は現れない
  assert.deepEqual(nodes.map((n) => n.name), ['a', 'b', 'c']);
});

test('discoverDependencies: 取得できないノードは error 付きで残り、その先はたどらない', async () => {
  const lock = {
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '9.9.9' }, 'node_modules/c': { version: '1.0.0' } },
  };
  const project = { root: 'Z:/x', lock, lockVersions: new Map([['a', '1.0.0']]), lockResolver: createLockResolver(lock) };
  const client = fakeClient(ROUTES); // b@9.9.9 は 404
  const nodes = await discoverDependencies(project, [{ name: 'a', range: '^1.0.0', depType: 'dependencies' }], client);
  const b = nodes.find((n) => n.name === 'b');
  assert.equal(b.version, '9.9.9');
  assert.match(b.error, /404/);
  assert.equal(summarizeNodes(nodes).failed, 1);
  // 本調査で b は取得失敗行になる
  const row = await buildRow(b, project, client);
  assert.equal(row.ok, false);
  assert.equal(row.depth, 1);
  assert.deepEqual(row.parents, ['a@1.0.0']);
});
