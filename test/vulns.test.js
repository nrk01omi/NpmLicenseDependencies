import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VulnClient, attachVulnerabilities, affects, formatVulnDetails, formatVulnSummary, summarizeVulns } from '../src/vulns.js';
import { rowToCells, vulnCell, CSV_HEADER } from '../src/analyze.js';

/** npm の一括 advisories API の応答を模す */
const RESPONSE = {
  lodash: [
    { id: 1, url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', title: 'Prototype Pollution in lodash', severity: 'high', vulnerable_versions: '>=3.7.0 <4.17.19', cvss: { score: 7.4 }, cwe: ['CWE-1321'] },
    { id: 2, url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', title: 'Command Injection in lodash', severity: 'high', vulnerable_versions: '<4.17.21', cvss: { score: 7.2 }, cwe: [] },
    { id: 3, url: 'https://github.com/advisories/GHSA-old', title: 'Old issue', severity: 'moderate', vulnerable_versions: '<4.0.0', cvss: { score: 5 }, cwe: [] },
  ],
  express: [{ id: 4, url: 'https://github.com/advisories/GHSA-rv95-896h-c2vc', title: 'Open Redirect', severity: 'moderate', vulnerable_versions: '<4.19.2', cvss: { score: 6.1 }, cwe: [] }],
};

function fakeClient(handler) {
  const calls = [];
  const client = new VulnClient({
    retries: 0,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return handler(url, init);
    },
  });
  return { client, calls };
}

test('affects: vulnerable_versions の範囲にバージョンが入るかを semver で判定する', () => {
  assert.equal(affects({ vulnerable_versions: '<4.17.19' }, '4.17.15'), true);
  assert.equal(affects({ vulnerable_versions: '<4.17.19' }, '4.17.21'), false);
  assert.equal(affects({ vulnerable_versions: '>=3.7.0 <4.17.19' }, '3.6.0'), false);
  assert.equal(affects({ vulnerable_versions: '*' }, '1.0.0'), true);
  assert.equal(affects({}, '1.0.0'), true); // 範囲が無ければ安全側で該当扱い
});

test('VulnClient.lookup: name → versions をまとめて 1 回 POST し、版に該当する advisory だけを深刻度順で返す', async () => {
  const { client, calls } = fakeClient(async () => ({ ok: true, status: 200, json: async () => RESPONSE }));
  const map = await client.lookup([
    { name: 'lodash', version: '4.17.15' },
    { name: 'lodash', version: '4.17.21' },
    { name: 'express', version: '4.21.2' },
    { name: 'amqplib', version: '0.6.0' }, // 応答にキーが無い → 空
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
  assert.deepEqual(calls[0].body, { lodash: ['4.17.15', '4.17.21'], express: ['4.21.2'], amqplib: ['0.6.0'] });
  const l15 = map.get('lodash@4.17.15');
  assert.deepEqual(l15.map((a) => a.id), ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw']); // 4.0.0 未満の advisory は除外
  assert.equal(l15[0].severity, 'high');
  assert.equal(l15[0].cvssScore, 7.2);
  assert.equal(l15[0].url, 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm');
  assert.deepEqual(map.get('lodash@4.17.21'), []);
  assert.deepEqual(map.get('express@4.21.2'), []);
  assert.deepEqual(map.get('amqplib@0.6.0'), []);
});

test('VulnClient.lookup: レジストリ URL を差し替えられ、5xx はリトライ後にエラーになる', async () => {
  let n = 0;
  const client = new VulnClient({
    registryUrl: 'https://mirror.example.com/npm/',
    retries: 1,
    fetchImpl: async (url) => {
      n += 1;
      assert.equal(url, 'https://mirror.example.com/npm/-/npm/v1/security/advisories/bulk');
      return { ok: false, status: 503, json: async () => ({}) };
    },
  });
  await assert.rejects(() => client.lookup([{ name: 'a', version: '1.0.0' }]), /HTTP 503/);
  assert.equal(n, 2);
});

test('summarizeVulns / formatVulnSummary / formatVulnDetails', () => {
  const list = [
    { id: 'GHSA-1', url: 'https://x/1', title: 'A', severity: 'high', vulnerableVersions: '<2', cvssScore: 7.5, cwe: [] },
    { id: 'GHSA-2', url: 'https://x/2', title: 'B', severity: 'moderate', vulnerableVersions: '', cvssScore: null, cwe: [] },
  ];
  assert.deepEqual(summarizeVulns(list), { count: 2, highest: 'high', bySeverity: { high: 1, moderate: 1 } });
  assert.equal(formatVulnSummary(list), 'あり 2 件 (最高 high; high 1, moderate 1)');
  assert.equal(formatVulnSummary([]), 'なし');
  assert.equal(formatVulnDetails(list), 'GHSA-1 [high 7.5] A (影響: <2) https://x/1; GHSA-2 [moderate] B https://x/2');
});

test('attachVulnerabilities: ok な行にだけ付け、失敗時は vulnStatus=error と備考で残す', async () => {
  const rows = [
    { ok: true, name: 'lodash', version: '4.17.15', note: '' },
    { ok: true, name: 'express', version: '4.21.2', note: '' },
    { ok: false, name: 'x', version: '^1.0.0', note: '取得失敗' },
    null,
  ];
  const { client } = fakeClient(async () => ({ ok: true, status: 200, json: async () => RESPONSE }));
  const s = await attachVulnerabilities(rows, client);
  assert.deepEqual(s, { checked: 2, withVulns: 1, advisories: 2, error: null });
  assert.equal(rows[0].vulnStatus, 'ok');
  assert.equal(rows[0].vulnHighest, 'high');
  assert.equal(rows[0].vulns.length, 2);
  assert.equal(rows[1].vulnStatus, 'ok');
  assert.deepEqual(rows[1].vulns, []);
  assert.equal(rows[2].vulnStatus, undefined);
  assert.equal(vulnCell(rows[0]), 'あり 2 件 (最高 high; high 2)');
  assert.equal(vulnCell(rows[1]), 'なし');

  const failing = fakeClient(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const rows2 = [{ ok: true, name: 'lodash', version: '4.17.15', note: 'x' }];
  const s2 = await attachVulnerabilities(rows2, failing.client);
  assert.match(s2.error, /HTTP 500/);
  assert.equal(rows2[0].vulnStatus, 'error');
  assert.match(rows2[0].note, /^x \/ 脆弱性確認失敗: /);
  assert.equal(vulnCell(rows2[0]), '確認失敗');
});

test('rowToCells: ⑥ の 2 列は 一致状態 の後ろ、リポジトリ の前に入る', () => {
  const row = {
    ok: true, name: 'lodash', version: '4.17.15', depType: 'dependencies', depth: 0, parents: [], license: 'MIT',
    dependencies: [], dependenciesResolved: [], siteDependencies: [], match: '', repository: 'r', note: '',
    vulnStatus: 'ok', vulnHighest: 'high',
    vulns: [{ id: 'GHSA-1', url: 'https://x/1', title: 'A', severity: 'high', vulnerableVersions: '<2', cvssScore: 7.5, cwe: [] }],
  };
  const cells = rowToCells(row);
  assert.equal(cells.length, CSV_HEADER.length);
  assert.equal(CSV_HEADER[14], '脆弱性');
  assert.equal(CSV_HEADER[15], '脆弱性の詳細');
  assert.equal(cells[14], 'あり 1 件 (最高 high; high 1)');
  assert.equal(cells[15], 'GHSA-1 [high 7.5] A (影響: <2) https://x/1');
  assert.equal(cells[16], 'r');
});
