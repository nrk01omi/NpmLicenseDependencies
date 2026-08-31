import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { listDirectDependencies, lockToVersionMap } from '../src/project.js';

const fixtureLock = JSON.parse(await readFile(new URL('./fixtures/package-lock.v3.json', import.meta.url), 'utf8'));
const fixturePkg = JSON.parse(await readFile(new URL('./fixtures/package.json', import.meta.url), 'utf8'));

test('lockfileVersion 3: トップレベルの node_modules/<name> からバージョンを引く', () => {
  const map = lockToVersionMap(fixtureLock);
  assert.equal(map.get('express'), '4.21.2');
  assert.equal(map.get('@scope/pkg'), '2.0.0');
  assert.equal(map.get('debug'), '2.6.9'); // トップレベル優先
  assert.equal(map.get('ms'), '2.1.3'); // ネストのみ → フォールバック
  assert.equal(map.has(''), false); // ルートエントリは含めない
});

test('lockfileVersion 1: dependencies[<name>].version からバージョンを引く', () => {
  const map = lockToVersionMap({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0' }, b: { version: '2.0.0' } } });
  assert.equal(map.get('a'), '1.0.0');
  assert.equal(map.get('b'), '2.0.0');
});

test('listDirectDependencies: 既定では dependencies のみ、--include-dev で devDependencies も含む', () => {
  const prod = listDirectDependencies(fixturePkg);
  assert.deepEqual(prod.map((d) => d.name), ['@scope/pkg', 'express']);
  assert.equal(prod[1].range, '^4.21.2');
  assert.equal(prod[1].depType, 'dependencies');

  const all = listDirectDependencies(fixturePkg, { includeDev: true });
  assert.deepEqual(all.map((d) => d.name), ['@scope/pkg', 'express', 'vitest']);
  assert.equal(all[2].depType, 'devDependencies');
});
