import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderRows, orderRowsTree, normalizeOrder, rowToCells, rowsFromCsv, CSV_HEADER } from '../src/analyze.js';
import { toCsv } from '../src/csv.js';

const row = (name, version, depth, parents = []) => ({ name, version, depth, parents, ok: true });

// 直接依存 b, a（package.json の順）と、その下の推移的依存。c は a と b の両方から要求される
const ROWS = [
  row('b', '1.0.0', 0),
  row('a', '1.0.0', 0),
  row('c', '1.0.0', 1, ['a@1.0.0', 'b@1.0.0']),
  row('d', '1.0.0', 1, ['b@1.0.0']),
  row('e', '1.0.0', 2, ['d@1.0.0']),
  row('z', '1.0.0', 2, ['c@1.0.0']),
];

test('orderRowsTree: 直接依存は元の順、その直下に子を名前順で深さ優先。複数の親を持つ行は最初の位置だけ', () => {
  const out = orderRowsTree(ROWS).map((r) => r.name);
  // b → (c → z), d → e ／ a → c は既出なので出ない
  assert.deepEqual(out, ['b', 'c', 'z', 'd', 'e', 'a']);
});

test('orderRowsTree: 取得中 (null) の行は末尾に残し、再帰でない結果は元の順のまま', () => {
  const plain = [row('y', '1.0.0', 0), null, row('x', '1.0.0', 0)];
  assert.deepEqual(orderRowsTree(plain).map((r) => (r ? r.name : null)), ['y', 'x', null]);
});

test('orderRows: depth は 深さ → 名前 の順', () => {
  assert.deepEqual(orderRows(ROWS, 'depth').map((r) => r.name), ['a', 'b', 'c', 'd', 'e', 'z']);
  assert.deepEqual(orderRows(ROWS, 'tree').map((r) => r.name), ['b', 'c', 'z', 'd', 'e', 'a']);
});

test('normalizeOrder: 不正値は tree', () => {
  assert.equal(normalizeOrder('depth'), 'depth');
  assert.equal(normalizeOrder('tree'), 'tree');
  assert.equal(normalizeOrder('x'), 'tree');
  assert.equal(normalizeOrder(undefined), 'tree');
});

test('orderRows(tree, expandDuplicates): 画面と同じく既出行も出し、dup / level / treeParent を付ける', () => {
  // a → b, c ／ b → c （c は 2 つの親から要求される）
  const rows = [
    { name: 'a', version: '1.0.0', depth: 0, parents: [] },
    { name: 'b', version: '1.0.0', depth: 1, parents: ['a@1.0.0'] },
    { name: 'c', version: '1.0.0', depth: 1, parents: ['a@1.0.0', 'b@1.0.0'] },
  ];
  const plain = orderRows(rows, 'tree');
  assert.deepEqual(plain.map((r) => r.name), ['a', 'b', 'c']); // 既定は 1 行 1 パッケージ

  const expanded = orderRows(rows, 'tree', { expandDuplicates: true });
  // a の子は名前順に b, c。b を先に降りるので c の実体は b の下（深さ 2）、a の下の c は「既出」になる
  assert.deepEqual(expanded.map((r) => `${r.name}${r.dup ? '(既出)' : ''}`), ['a', 'b', 'c', 'c(既出)']);
  assert.deepEqual(expanded.map((r) => r.level), [0, 1, 2, 1]);
  assert.deepEqual(expanded.map((r) => r.treeParent), ['', 'a@1.0.0', 'b@1.0.0', 'a@1.0.0']);
  assert.equal(rows[2].dup, undefined); // 元の行は書き換えない
});

test('orderRows(depth): 既出の展開はしない', () => {
  const rows = [
    { name: 'a', version: '1.0.0', depth: 0, parents: [] },
    { name: 'c', version: '1.0.0', depth: 1, parents: ['a@1.0.0', 'b@1.0.0'] },
  ];
  assert.deepEqual(orderRows(rows, 'depth', { expandDuplicates: true }).map((r) => r.name), ['a', 'c']);
});

test('rowToCells / rowsFromCsv: 既出行は CSV に出るが、読み込み時は落とす', () => {
  const base = {
    ok: true, name: 'c', version: '1.0.0', depType: 'transitive', source: '両方', depth: 1,
    parents: ['a@1.0.0', 'b@1.0.0'], license: 'MIT', dependencies: [], dependenciesResolved: [],
    siteDependencies: [], siteStatus: 'skipped', match: '', vulns: [], vulnStatus: 'skipped', repository: '', note: '',
  };
  const cells = rowToCells({ ...base, dup: true, level: 2, treeParent: 'b@1.0.0' });
  assert.equal(cells[CSV_HEADER.indexOf('既出')], '既出');
  assert.equal(cells[CSV_HEADER.indexOf('表示階層')], '2');
  assert.equal(cells[CSV_HEADER.indexOf('表示上の親')], 'b@1.0.0');

  const text = toCsv(CSV_HEADER, [rowToCells({ ...base, dup: false, level: 1, treeParent: 'a@1.0.0' }), cells]);
  const parsed = rowsFromCsv(text);
  assert.equal(parsed.rows.length, 1); // 既出行は復元しない
  assert.equal(parsed.skippedDuplicates, 1);
  assert.equal(parsed.rows[0].name, 'c');
});
