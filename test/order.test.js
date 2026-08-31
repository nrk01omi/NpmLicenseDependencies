import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderRows, orderRowsTree, normalizeOrder } from '../src/analyze.js';

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
