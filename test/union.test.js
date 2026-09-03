import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SOURCE, DEP_TYPE_TRANSITIVE, mergeDirectDependencies, mergeLockPackages, markSources } from '../src/analyze.js';
import { listDirectDependencies, listLockRootDependencies, createLockResolver, lockToVersionMap } from '../src/project.js';

const lock = JSON.parse(await readFile(new URL('./fixtures/package-lock.v3.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('./fixtures/package.json', import.meta.url), 'utf8'));
const project = { root: '/tmp/fixture', packageJson, lock, lockVersions: lockToVersionMap(lock), lockResolver: createLockResolver(lock) };

test('mergeDirectDependencies: package.json と lock ルートの OR。両方にあれば取得元は 両方', () => {
  const merged = mergeDirectDependencies(
    listDirectDependencies(packageJson),
    listLockRootDependencies(lock),
  );
  assert.deepEqual(merged.map((d) => d.name), ['@scope/pkg', 'express']);
  assert.deepEqual(merged.map((d) => d.source), [SOURCE.BOTH, SOURCE.BOTH]);
});

test('mergeDirectDependencies: lock のルートにしか無い直接依存も行にする', () => {
  const merged = mergeDirectDependencies(
    [{ name: 'express', range: '^4.21.2', depType: 'dependencies' }],
    [{ name: 'express', range: '^4.21.2', depType: 'dependencies' }, { name: 'left-pad', range: '^1.3.0', depType: 'dependencies' }],
  );
  assert.deepEqual(merged.map((d) => [d.name, d.source]), [['express', SOURCE.BOTH], ['left-pad', SOURCE.LOCK]]);
});

test('mergeLockPackages: 非再帰（名前で既出判定）でも lock にしか無いライブラリを行に足す', () => {
  const deps = mergeDirectDependencies(listDirectDependencies(packageJson), listLockRootDependencies(lock));
  const targets = mergeLockPackages(deps, project, { matchByName: true });
  assert.deepEqual(targets.map((t) => t.name).sort(), ['@scope/pkg', 'debug', 'express', 'ms']);
  const debug = targets.find((t) => t.name === 'debug');
  assert.equal(debug.source, SOURCE.LOCK);
  assert.equal(debug.version, '2.6.9');
  assert.equal(debug.depType, DEP_TYPE_TRANSITIVE);
  assert.match(debug.note, /package-lock\.json のみ/);
  const ms = targets.find((t) => t.name === 'ms');
  assert.deepEqual(ms.lockPath, ['debug', 'ms']); // ネストされた実体の位置を保つ
  assert.equal(ms.depth, 1);
});

test('mergeLockPackages: 再帰調査のノードにある name@version は重複させない', () => {
  const nodes = [
    { name: 'express', version: '4.21.2', depType: 'dependencies', depth: 0, parents: [], lockPath: ['express'] },
    { name: 'debug', version: '2.6.9', depType: DEP_TYPE_TRANSITIVE, depth: 1, parents: ['express@4.21.2'], lockPath: ['debug'] },
  ];
  const targets = mergeLockPackages(nodes, project, {});
  assert.deepEqual(targets.map((t) => `${t.name}@${t.version}`).sort(), [
    '@scope/pkg@2.0.0', 'debug@2.6.9', 'express@4.21.2', 'ms@2.1.3',
  ]);
  assert.equal(targets.find((t) => t.name === 'debug').source, SOURCE.BOTH);
  assert.equal(targets.find((t) => t.name === '@scope/pkg').source, SOURCE.LOCK); // package.json からはたどっていない
});

test('mergeLockPackages: dev は includeDev のときだけ足す', () => {
  const prod = mergeLockPackages([], project, {});
  assert.equal(prod.some((t) => t.name === 'vitest'), false);
  const all = mergeLockPackages([], project, { includeDev: true });
  assert.equal(all.some((t) => t.name === 'vitest'), true);
});

test('markSources: lock 側に無いものは package.json のまま', () => {
  const marked = markSources([{ name: 'nope', version: '1.0.0' }, { name: 'express', version: '4.21.2' }], project);
  assert.deepEqual(marked.map((t) => t.source), [SOURCE.PACKAGE_JSON, SOURCE.BOTH]);
});

test('mergeLockPackages: lock が無いプロジェクトでは取得元を付けるだけ', () => {
  const noLock = { root: '/tmp/x', packageJson, lock: null, lockVersions: new Map(), lockResolver: createLockResolver(null) };
  const targets = mergeLockPackages([{ name: 'express', range: '^4.21.2', depType: 'dependencies' }], noLock, {});
  assert.deepEqual(targets.map((t) => [t.name, t.source]), [['express', SOURCE.PACKAGE_JSON]]);
});
