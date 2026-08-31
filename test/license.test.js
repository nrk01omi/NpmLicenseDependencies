import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLicense } from '../src/license.js';

test('文字列の license はそのまま返す', () => {
  assert.equal(normalizeLicense({ license: 'MIT' }), 'MIT');
  assert.equal(normalizeLicense({ license: ' Apache-2.0 ' }), 'Apache-2.0');
});

test('オブジェクト形式の license は type を返す', () => {
  assert.equal(normalizeLicense({ license: { type: 'BSD-3-Clause', url: 'x' } }), 'BSD-3-Clause');
});

test('旧形式 licenses 配列は OR で連結する', () => {
  assert.equal(
    normalizeLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
    'MIT OR Apache-2.0',
  );
});

test('license が無い場合は UNKNOWN', () => {
  assert.equal(normalizeLicense({}), 'UNKNOWN');
  assert.equal(normalizeLicense({ license: '' }), 'UNKNOWN');
  assert.equal(normalizeLicense(null), 'UNKNOWN');
});
