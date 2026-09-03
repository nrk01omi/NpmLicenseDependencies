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
    lockResolver: createLockResolver(lock),
  };
}

/**
 * package-lock.json を Node の解決順で引くリゾルバを作る。
 *   resolve(name, parentPath) — parentPath は親パッケージの lock 上の位置（例: ['winston'] や ['a', 'b']）。
 *   親の直下 (node_modules/親/node_modules/name) → 祖先の直下 → トップレベル (node_modules/name) の順に探し、
 *   最初に見つかった { version, path } を返す。無ければ null。
 * lockfileVersion 2/3 は packages のキー、v1 は dependencies の入れ子をたどる。
 * トップレベル優先の lockToVersionMap と違い、ネストされた別バージョンを使う親では正しくネスト側を返す。
 */
export function createLockResolver(lock) {
  const empty = { size: 0, resolve: () => null };
  if (!lock || typeof lock !== 'object') return empty;

  if (lock.packages && typeof lock.packages === 'object') {
    const pkgs = lock.packages;
    const keyOf = (pathArr) => pathArr.map((n) => `node_modules/${n}`).join('/');
    return {
      size: Object.keys(pkgs).filter((k) => k.startsWith('node_modules/')).length,
      resolve(name, parentPath = []) {
        for (let i = parentPath.length; i >= 0; i -= 1) {
          const candidate = [...parentPath.slice(0, i), name];
          const entry = pkgs[keyOf(candidate)];
          if (entry && typeof entry.version === 'string') return { version: entry.version, path: candidate };
        }
        return null;
      },
    };
  }

  if (lock.dependencies && typeof lock.dependencies === 'object') {
    const entryAt = (pathArr) => {
      let deps = lock.dependencies;
      let entry = null;
      for (const n of pathArr) {
        entry = deps && deps[n];
        if (!entry) return null;
        deps = entry.dependencies;
      }
      return entry;
    };
    const count = (deps) =>
      Object.values(deps ?? {}).reduce((n, e) => n + 1 + (e && e.dependencies ? count(e.dependencies) : 0), 0);
    return {
      size: count(lock.dependencies),
      resolve(name, parentPath = []) {
        for (let i = parentPath.length; i >= 0; i -= 1) {
          const candidate = [...parentPath.slice(0, i), name];
          const entry = entryAt(candidate);
          if (entry && typeof entry.version === 'string') return { version: entry.version, path: candidate };
        }
        return null;
      },
    };
  }
  return empty;
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

/**
 * package-lock.json に載っているパッケージをすべて列挙する（node_modules 配下の実体エントリ）。
 * lockfileVersion 2/3 は packages の "node_modules/…" キー、v1 は dependencies の入れ子をたどる。
 * ネストされた同名別バージョンもそれぞれ 1 件として返す。
 *
 * @param {object|null} lock
 * @param {{ includeDev?: boolean }} [options]  includeDev=false のとき dev / devOptional のみのものは除く
 * @returns {Array<{ name: string, version: string, lockPath: string[], dev: boolean, optional: boolean }>}
 */
export function listLockPackages(lock, options = {}) {
  const { includeDev = false } = options;
  const out = [];
  if (!lock || typeof lock !== 'object') return out;

  if (lock.packages && typeof lock.packages === 'object') {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/')) continue;
      if (!entry || typeof entry.version !== 'string' || entry.link) continue;
      const dev = Boolean(entry.dev || entry.devOptional);
      if (dev && !includeDev) continue;
      const lockPath = key.slice('node_modules/'.length).split('/node_modules/');
      out.push({ name: lockPath[lockPath.length - 1], version: entry.version, lockPath, dev, optional: Boolean(entry.optional) });
    }
    return out;
  }

  if (lock.dependencies && typeof lock.dependencies === 'object') {
    const walk = (deps, parentPath) => {
      for (const [name, entry] of Object.entries(deps ?? {})) {
        if (!entry || typeof entry.version !== 'string') continue;
        const lockPath = [...parentPath, name];
        const dev = Boolean(entry.dev);
        if (!dev || includeDev) out.push({ name, version: entry.version, lockPath, dev, optional: Boolean(entry.optional) });
        if (entry.dependencies) walk(entry.dependencies, lockPath);
      }
    };
    walk(lock.dependencies, []);
  }
  return out;
}

/**
 * package-lock.json のルート（packages[""]）に記録された直接依存を返す。
 * package.json と食い違っている（lock だけが知っている）直接依存を拾うために使う。
 * v1 形式にはルートの依存記録が無いので空配列。
 *
 * @returns {Array<{ name: string, range: string, depType: string }>}
 */
export function listLockRootDependencies(lock, options = {}) {
  const { includeDev = false } = options;
  const root = lock && lock.packages && typeof lock.packages === 'object' ? lock.packages[''] : null;
  if (!root || typeof root !== 'object') return [];
  const sections = includeDev
    ? ['dependencies', 'optionalDependencies', 'devDependencies']
    : ['dependencies', 'optionalDependencies'];
  const out = [];
  for (const depType of sections) {
    const deps = root[depType];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, range] of Object.entries(deps)) {
      out.push({ name, range: String(range), depType: depType === 'optionalDependencies' ? 'dependencies' : depType });
    }
  }
  return out;
}
