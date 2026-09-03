import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { listDirectDependencies, listLockPackages, listLockRootDependencies, lockToVersionMap } from '../src/project.js';

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

test('listLockPackages: lock 上の実体エントリをすべて列挙し、ネストは lockPath で区別する', () => {
  const prod = listLockPackages(fixtureLock);
  assert.deepEqual(
    prod.map((p) => `${p.name}@${p.version}`).sort(),
    ['@scope/pkg@2.0.0', 'debug@2.6.9', 'express@4.21.2', 'ms@2.1.3'],
  );
  assert.deepEqual(prod.find((p) => p.name === 'ms').lockPath, ['debug', 'ms']);
  assert.deepEqual(prod.find((p) => p.name === '@scope/pkg').lockPath, ['@scope/pkg']);

  const all = listLockPackages(fixtureLock, { includeDev: true });
  assert.equal(all.some((p) => p.name === 'vitest'), true); // dev は includeDev のときだけ
});

test('listLockPackages: lockfileVersion 1 は dependencies の入れ子をたどる', () => {
  const list = listLockPackages({
    lockfileVersion: 1,
    dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } }, d: { version: '3.0.0', dev: true } },
  });
  assert.deepEqual(list.map((p) => p.lockPath), [['a'], ['a', 'b']]);
});

test('listLockRootDependencies: lock のルートに記録された直接依存を返す', () => {
  assert.deepEqual(listLockRootDependencies(fixtureLock).map((d) => d.name), ['@scope/pkg', 'express']);
  assert.deepEqual(listLockRootDependencies(fixtureLock, { includeDev: true }).map((d) => d.name), ['@scope/pkg', 'express', 'vitest']);
  assert.deepEqual(listLockRootDependencies({ lockfileVersion: 1, dependencies: {} }), []);
});
