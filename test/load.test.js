import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../src/csv.js';
import { rowsFromCsv, rowToCells, parseVulnDetails, CSV_HEADER, MATCH } from '../src/analyze.js';

test('parseCsv: BOM・CRLF・クォート内のカンマ/改行/"" を扱い、toCsv と往復できる', () => {
  const rows = [
    ['a', 'x,y', 'line1\nline2', 'say "hi"'],
    ['b', '', '', ''],
  ];
  const text = toCsv(['h1', 'h2', 'h3', 'h4'], rows);
  const back = parseCsv(text);
  assert.deepEqual(back, [['h1', 'h2', 'h3', 'h4'], ...rows]);
  // LF のみでも同じ
  assert.deepEqual(parseCsv('h1,h2\n1,2\n'), [['h1', 'h2'], ['1', '2']]);
  assert.deepEqual(parseCsv(''), []);
});

const FULL_ROW = {
  ok: true,
  name: 'axios',
  version: '1.14.0',
  depType: 'dependencies',
  depth: 0,
  parents: [],
  license: 'MIT',
  dependencies: ['follow-redirects@^1.15.11', 'form-data@^4.0.5'],
  dependenciesResolved: ['follow-redirects@1.15.11', 'form-data@4.0.5'],
  siteDependencies: ['follow-redirects', 'form-data'],
  siteStatus: 'ok',
  siteUrl: 'https://www.npmjs.com/package/axios/v/1.14.0?activeTab=dependencies',
  match: MATCH.ALL,
  counts: { dependencies: 2, resolved: 2, site: 2 },
  vulns: [
    { id: 'GHSA-1111', url: 'https://github.com/advisories/GHSA-1111', title: 'Bad thing, with comma', severity: 'high', vulnerableVersions: '>=1.0.0 <1.15.2', cvssScore: 7.4, cwe: [] },
    { id: 'GHSA-2222', url: 'https://github.com/advisories/GHSA-2222', title: 'Other', severity: 'moderate', vulnerableVersions: '', cvssScore: null, cwe: [] },
  ],
  vulnStatus: 'ok',
  vulnHighest: 'high',
  repository: 'git+https://github.com/axios/axios.git',
  note: 'lock 未解決: x / サイトのみ: y',
};
const TRANSITIVE_ROW = {
  ...FULL_ROW,
  name: 'form-data',
  version: '4.0.5',
  depType: 'transitive',
  depth: 1,
  parents: ['axios@1.14.0', 'other@2.0.0'],
  dependencies: [],
  dependenciesResolved: [],
  siteDependencies: [],
  match: MATCH.UNKNOWN,
  counts: { dependencies: 0, resolved: 0, site: 0 },
  vulns: [],
  vulnStatus: 'error',
  vulnHighest: null,
  note: '脆弱性確認失敗: HTTP 500',
};
const FAILED_ROW = {
  ok: false,
  name: 'broken',
  version: '^1.0.0',
  depType: 'dependencies',
  depth: 0,
  parents: [],
  license: '取得失敗',
  dependencies: [],
  dependenciesResolved: [],
  siteDependencies: [],
  siteStatus: 'skipped',
  siteUrl: '',
  match: '',
  counts: null,
  vulns: [],
  vulnStatus: 'skipped',
  vulnHighest: null,
  repository: '',
  note: 'レジストリに存在しません (404)',
};

test('rowsFromCsv: 保存した CSV から行を復元できる（往復で主要項目が一致）', () => {
  const text = toCsv(CSV_HEADER, [FULL_ROW, TRANSITIVE_ROW, FAILED_ROW].map(rowToCells));
  const { rows, missing } = rowsFromCsv(text);
  assert.deepEqual(missing, []);
  assert.equal(rows.length, 3);

  const a = rows[0];
  assert.equal(a.ok, true);
  assert.equal(a.name, 'axios');
  assert.equal(a.version, '1.14.0');
  assert.equal(a.depth, 0);
  assert.deepEqual(a.parents, []);
  assert.equal(a.license, 'MIT');
  assert.deepEqual(a.dependencies, FULL_ROW.dependencies);
  assert.deepEqual(a.dependenciesResolved, FULL_ROW.dependenciesResolved);
  assert.deepEqual(a.siteDependencies, FULL_ROW.siteDependencies);
  assert.equal(a.siteStatus, 'ok');
  assert.equal(a.siteUrl, FULL_ROW.siteUrl);
  assert.equal(a.match, MATCH.ALL);
  assert.deepEqual(a.counts, { dependencies: 2, resolved: 2, site: 2 });
  assert.equal(a.vulnStatus, 'ok');
  assert.equal(a.vulnHighest, 'high');
  assert.equal(a.vulns.length, 2);
  assert.deepEqual(a.vulns[0], { id: 'GHSA-1111', severity: 'high', cvssScore: 7.4, title: 'Bad thing, with comma', vulnerableVersions: '>=1.0.0 <1.15.2', url: 'https://github.com/advisories/GHSA-1111', cwe: [] });
  assert.deepEqual(a.vulns[1], { id: 'GHSA-2222', severity: 'moderate', cvssScore: null, title: 'Other', vulnerableVersions: '', url: 'https://github.com/advisories/GHSA-2222', cwe: [] });
  assert.equal(a.repository, FULL_ROW.repository);
  assert.equal(a.note, FULL_ROW.note);

  const t = rows[1];
  assert.equal(t.depType, 'transitive');
  assert.equal(t.depth, 1);
  assert.deepEqual(t.parents, ['axios@1.14.0', 'other@2.0.0']);
  assert.equal(t.siteStatus, 'error'); // 一致状態が「サイト未取得」
  assert.equal(t.vulnStatus, 'error'); // 脆弱性が「確認失敗」
  assert.deepEqual(t.vulns, []);

  const f = rows[2];
  assert.equal(f.ok, false);
  assert.equal(f.license, '取得失敗');
  assert.equal(f.siteStatus, 'skipped');
  assert.equal(f.vulnStatus, 'skipped');
  assert.equal(f.siteUrl, '');

  // 復元した行を再び CSV にすると同じ内容になる
  assert.equal(toCsv(CSV_HEADER, rows.map(rowToCells)), text);
});

test('rowsFromCsv: 古い形式（列が少ない）でも、ある列だけで復元し、無い列を報告する', () => {
  const oldHeader = ['ライブラリ名', 'バージョン', '依存種別', 'ライセンス', '依存ライブラリ', '取得済みライブラリ', 'リポジトリ', '備考'];
  const text = toCsv(oldHeader, [['axios', '1.14.0', 'dependencies', 'MIT', 'a@^1; b@^2', 'a@1.0.0', 'repo', '']]);
  const { rows, missing } = rowsFromCsv(text);
  assert.deepEqual(missing, ['取得元', '深さ', '要求元', 'npm サイトの dependencies', '一致状態', '脆弱性', '脆弱性の詳細']);
  assert.equal(rows[0].source, 'package.json');
  assert.equal(rows[0].depth, 0);
  assert.deepEqual(rows[0].dependencies, ['a@^1', 'b@^2']);
  assert.equal(rows[0].siteStatus, 'skipped');
  assert.equal(rows[0].match, '');
  assert.equal(rows[0].vulnStatus, 'skipped');
});

test('rowsFromCsv: このツールの CSV でなければエラー', () => {
  assert.throws(() => rowsFromCsv('a,b\n1,2\n'), /ライブラリ名/);
  assert.throws(() => rowsFromCsv(''), /空/);
});

test('parseVulnDetails: 書式が崩れた項目も落とさず info として残す', () => {
  const list = parseVulnDetails('GHSA-1 [high 7.5] A (影響: <2) https://x/1; GHSA-2 [low] B https://x/2');
  assert.deepEqual(list.map((v) => v.id), ['GHSA-1', 'GHSA-2']);
  assert.equal(list[1].cvssScore, null);
  const junk = parseVulnDetails('なんらかの文字列');
  assert.equal(junk.length, 1);
  assert.equal(junk[0].severity, 'info');
  assert.equal(junk[0].title, 'なんらかの文字列');
  assert.deepEqual(parseVulnDetails(''), []);
});
