import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRow, buildRowWithRetry, isRegistryRange, resolveVersion, rowToCells } from '../src/analyze.js';
import { RegistryClient } from '../src/registry.js';

/** fetch を差し替えたレジストリクライアント（ネットワーク不要） */
function fakeClient(routes) {
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    const body = routes[pathname];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return new RegistryClient({ fetchImpl, cacheDir: null, retries: 0 });
}

const project = {
  root: 'Z:/nonexistent-project',
  lock: {},
  lockVersions: new Map([
    ['express', '4.21.2'],
    ['body-parser', '1.20.3'],
    ['cookie', '0.7.1'],
  ]),
};

test('buildRow: lock のバージョンでレジストリを引き、ライセンスと依存を並べる', async () => {
  const client = fakeClient({
    '/express/4.21.2': {
      name: 'express',
      version: '4.21.2',
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/expressjs/express.git' },
      dependencies: { cookie: '0.7.1', 'body-parser': '1.20.3', debug: '2.6.9' },
    },
  });
  const row = await buildRow({ name: 'express', range: '^4.21.2', depType: 'dependencies' }, project, client);
  assert.deepEqual(row, {
    ok: true,
    name: 'express',
    version: '4.21.2',
    depType: 'dependencies',
    license: 'MIT',
    dependencies: ['body-parser@1.20.3', 'cookie@0.7.1', 'debug@2.6.9'],
    dependenciesResolved: ['body-parser@1.20.3', 'cookie@0.7.1'],
    repository: 'git+https://github.com/expressjs/express.git',
    note: 'lock 未解決: debug',
  });
  assert.deepEqual(rowToCells(row), [
    'express',
    '4.21.2',
    'dependencies',
    'MIT',
    'body-parser@1.20.3; cookie@0.7.1; debug@2.6.9',
    'body-parser@1.20.3; cookie@0.7.1',
    'git+https://github.com/expressjs/express.git',
    'lock 未解決: debug',
  ]);
});

test('buildRow: 404 の場合は行を落とさず取得失敗として返す', async () => {
  const client = fakeClient({});
  const row = await buildRow({ name: 'express', range: '^4.21.2', depType: 'dependencies' }, project, client);
  assert.equal(row.ok, false);
  assert.equal(row.name, 'express');
  assert.equal(row.license, '取得失敗');
  assert.match(row.note, /404/);
});

test('resolveVersion: lock に無い場合は packument から範囲解決する', async () => {
  const client = fakeClient({
    '/lodash': { 'dist-tags': { latest: '4.17.21' }, versions: { '4.17.20': {}, '4.17.21': {}, '5.0.0-beta.1': {} } },
  });
  const r = await resolveVersion({ name: 'lodash', range: '^4.17.0', depType: 'dependencies' }, project, client);
  assert.equal(r.version, '4.17.21');
  assert.match(r.note, /範囲解決/);
});

test('resolveVersion: versionMode=latest は lock にあっても dist-tags.latest を使い、差があれば備考に書く', async () => {
  const client = fakeClient({
    '/express': { 'dist-tags': { latest: '5.1.0' }, versions: { '4.21.2': {}, '5.1.0': {} } },
  });
  const r = await resolveVersion({ name: 'express', range: '^4.21.2', depType: 'dependencies' }, project, client, { versionMode: 'latest' });
  assert.equal(r.version, '5.1.0');
  assert.match(r.note, /最新版 5\.1\.0/);
  assert.match(r.note, /インストール済みは 4\.21\.2/);

  // 既定 (installed) は lock を優先し、packument を取りに行かない
  const r2 = await resolveVersion({ name: 'express', range: '^4.21.2', depType: 'dependencies' }, project, client);
  assert.equal(r2.version, '4.21.2');
});

test('resolveVersion: スコープ付きパッケージは @scope%2Fname でエンコードして問い合わせる', async () => {
  const seen = [];
  const client = new RegistryClient({
    cacheDir: null,
    retries: 0,
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': {} } }) };
    },
  });
  await resolveVersion({ name: '@scope/pkg', range: '^1.0.0', depType: 'dependencies' }, project, client);
  assert.equal(seen[0], 'https://registry.npmjs.org/@scope%2Fpkg');
});

test('buildRowWithRetry: onError が retry を返す間は再取得し、ignore で失敗行のまま返す', async () => {
  let calls = 0;
  const client = new RegistryClient({
    cacheDir: null,
    retries: 0,
    fetchImpl: async () => {
      calls += 1;
      // 3 回目で成功する
      if (calls < 3) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ name: 'express', version: '4.21.2', license: 'MIT' }) };
    },
  });
  const decisions = [];
  const onError = async ({ attempt, row }) => {
    decisions.push({ attempt, ok: row.ok });
    return 'retry';
  };
  const row = await buildRowWithRetry({ name: 'express', range: '^4.21.2', depType: 'dependencies' }, 0, project, client, onError);
  assert.equal(row.ok, true);
  assert.deepEqual(decisions, [{ attempt: 1, ok: false }, { attempt: 2, ok: false }]);

  calls = 0;
  const ignored = await buildRowWithRetry(
    { name: 'express', range: '^4.21.2', depType: 'dependencies' },
    0,
    project,
    client,
    async () => 'ignore',
  );
  assert.equal(ignored.ok, false);
  assert.equal(calls, 1);
});

test('isRegistryRange: git/file/URL 指定はレジストリ外と判定する', () => {
  assert.equal(isRegistryRange('^1.0.0'), true);
  assert.equal(isRegistryRange('latest'), true);
  assert.equal(isRegistryRange('git+https://github.com/a/b.git'), false);
  assert.equal(isRegistryRange('file:../local'), false);
  assert.equal(isRegistryRange('user/repo'), false);
  assert.equal(isRegistryRange('github:user/repo'), false);
});
