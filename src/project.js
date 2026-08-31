import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 対象プロジェクトの package.json / package-lock.json / node_modules を読み込む。
 * package-lock.json と node_modules は任意（無ければ null / 空）。
 */
export async function loadProject(projectDir) {
  const root = path.resolve(projectDir);
  const packageJson = await readJson(path.join(root, 'package.json'));
  if (!packageJson) {
    throw new Error(`package.json が見つかりません: ${root}`);
  }
  const lock = await readJson(path.join(root, 'package-lock.json'));
  return {
    root,
    packageJson,
    lock,
    lockVersions: lock ? lockToVersionMap(lock) : new Map(),
  };
}

/**
 * package.json の直接依存を { name, range, depType } の配列で返す。
 * @param {object} packageJson
 * @param {{ includeDev?: boolean }} [options]
 */
export function listDirectDependencies(packageJson, options = {}) {
  const { includeDev = false } = options;
  const sections = ['dependencies'];
  if (includeDev) sections.push('devDependencies');

  const result = [];
  for (const depType of sections) {
    const deps = packageJson[depType];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, range] of Object.entries(deps)) {
      result.push({ name, range: String(range), depType });
    }
  }
  return result;
}

/**
 * package-lock.json から「トップレベルにインストールされたパッケージ名 → バージョン」の Map を作る。
 * lockfileVersion 2/3 は packages["node_modules/<name>"]、v1 は dependencies[<name>] を見る。
 * ネストされた node_modules/a/node_modules/b は、トップレベルに b が無い場合のみフォールバックとして使う。
 */
export function lockToVersionMap(lock) {
  const map = new Map();
  if (!lock || typeof lock !== 'object') return map;

  if (lock.packages && typeof lock.packages === 'object') {
    const nested = new Map();
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/') || !entry || typeof entry.version !== 'string') continue;
      const rel = key.slice('node_modules/'.length);
      if (rel.includes('node_modules/')) {
        const name = rel.slice(rel.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (!nested.has(name)) nested.set(name, entry.version);
      } else {
        map.set(rel, entry.version);
      }
    }
    for (const [name, version] of nested) {
      if (!map.has(name)) map.set(name, version);
    }
    return map;
  }

  if (lock.dependencies && typeof lock.dependencies === 'object') {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      if (entry && typeof entry.version === 'string') map.set(name, entry.version);
    }
  }
  return map;
}

/**
 * node_modules/<name>/package.json の version を返す。無ければ null。
 */
export async function readInstalledVersion(projectRoot, name) {
  const manifest = await readJson(path.join(projectRoot, 'node_modules', ...name.split('/'), 'package.json'));
  return manifest && typeof manifest.version === 'string' ? manifest.version : null;
}

async function readJson(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`${filePath} の読み込みに失敗しました: ${err.message}`);
  }
}
