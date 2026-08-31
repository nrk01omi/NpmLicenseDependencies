import semver from 'semver';

import { loadProject, listDirectDependencies, readInstalledVersion } from './project.js';
import { RegistryClient, RegistryNotFoundError } from './registry.js';
import { normalizeLicense } from './license.js';

export const CSV_HEADER = [
  'ライブラリ名',
  'バージョン',
  '依存種別',
  'ライセンス',
  '依存ライブラリ',
  '取得済みライブラリ',
  'リポジトリ',
  '備考',
];

/**
 * プロジェクト全体を解析する。CLI と Web UI の両方から使う。
 *
 * @param {object} options
 * @param {string} options.projectDir
 * @param {boolean} [options.includeDev]
 * @param {string|null} [options.cacheDir]
 * @param {string} [options.registryUrl]
 * @param {(ev: { index: number, row: object, completed: number, total: number }) => void} [options.onProgress]
 * @param {(ev: { project: object, deps: object[] }) => void} [options.onStart]
 * @param {(ev: { index: number, dep: object, row: object, attempt: number }) => Promise<'retry'|'ignore'>} [options.onError]
 *   取得に失敗したときに呼ばれる。'retry' を返すと同じ依存をもう一度取得し、'ignore' を返すと失敗行のまま次へ進む。
 *   省略時は 'ignore' 相当。
 */
export async function analyze(options) {
  const {
    projectDir,
    includeDev = false,
    cacheDir = null,
    registryUrl,
    versionMode = 'installed',
    onProgress,
    onStart,
    onError,
  } = options;
  const project = await loadProject(projectDir);
  const deps = listDirectDependencies(project.packageJson, { includeDev });
  onStart?.({ project, deps });

  const client = new RegistryClient({ registryUrl, cacheDir });
  const rows = new Array(deps.length);
  let completed = 0;
  await Promise.all(
    deps.map(async (dep, index) => {
      rows[index] = await buildRowWithRetry(dep, index, project, client, onError, { versionMode });
      completed += 1;
      onProgress?.({ index, row: rows[index], completed, total: deps.length });
    }),
  );
  return { project, deps, rows, stats: client.stats };
}

/** buildRow を実行し、失敗時は onError の判断に従ってリトライする。 */
export async function buildRowWithRetry(dep, index, project, client, onError, rowOptions = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const row = await buildRow(dep, project, client, rowOptions);
    if (row.ok || !onError) return row;
    const decision = await onError({ index, dep, row, attempt });
    if (decision !== 'retry') return row;
  }
}

/**
 * 1 つの直接依存について、バージョンを解決し、レジストリからマニフェストを取得して結果行を組み立てる。
 * 失敗しても行は落とさず ok=false で返す。
 *
 * @param {{ versionMode?: 'installed' | 'latest' }} [rowOptions]
 *   installed: package-lock / node_modules のバージョン（実際に使っているもの）
 *   latest:    npm レジストリの最新版（npm サイトのパッケージページの既定表示と同じ）
 */
export async function buildRow(dep, project, client, rowOptions = {}) {
  const notes = [];
  let version = null;
  let manifest = null;

  try {
    const resolved = await resolveVersion(dep, project, client, rowOptions);
    version = resolved.version;
    if (resolved.note) notes.push(resolved.note);
    manifest = await client.fetchManifest(dep.name, version);
  } catch (err) {
    const message = err instanceof RegistryNotFoundError ? err.message : `取得失敗: ${err.message}`;
    notes.push(message);
    return {
      ok: false,
      name: dep.name,
      version: version ?? dep.range,
      depType: dep.depType,
      license: '取得失敗',
      dependencies: [],
      dependenciesResolved: [],
      repository: '',
      note: notes.join(' / '),
    };
  }

  const deps = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  const depNames = Object.keys(deps).sort();
  const dependencies = depNames.map((n) => `${n}@${deps[n]}`);
  const dependenciesResolved = depNames
    .filter((n) => project.lockVersions.has(n))
    .map((n) => `${n}@${project.lockVersions.get(n)}`);
  if (depNames.length > 0 && project.lockVersions.size > 0) {
    const missing = depNames.filter((n) => !project.lockVersions.has(n));
    if (missing.length > 0) notes.push(`lock 未解決: ${missing.join(', ')}`);
  }

  return {
    ok: true,
    name: dep.name,
    version: manifest.version ?? version,
    depType: dep.depType,
    license: normalizeLicense(manifest),
    dependencies,
    dependenciesResolved,
    repository: repositoryUrl(manifest),
    note: notes.join(' / '),
  };
}

/** 結果行を CSV の 1 行（セル配列）に変換する。 */
export function rowToCells(row) {
  return [
    row.name,
    row.version,
    row.depType,
    row.license,
    row.dependencies.join('; '),
    row.dependenciesResolved.join('; '),
    row.repository,
    row.note,
  ];
}

/**
 * レジストリに問い合わせる正確なバージョンを決める。
 * versionMode = 'installed'（既定）: package-lock → node_modules → packument から semver.maxSatisfying → dist-tags.latest
 * versionMode = 'latest'          : 常に dist-tags.latest（npm サイトの既定表示と同じ）。インストール済みと違えば備考に記す
 */
export async function resolveVersion(dep, project, client, { versionMode = 'installed' } = {}) {
  const fromLock = project.lockVersions.get(dep.name);
  const installed = fromLock ?? (await readInstalledVersion(project.root, dep.name));

  if (versionMode === 'latest') {
    // 「最新版」が古いキャッシュにならないよう、packument は毎回取得する
    const packument = await client.fetchPackument(dep.name, { fresh: true });
    const latest = packument['dist-tags']?.latest;
    if (!latest) throw new Error('レジストリに latest タグがありません');
    const note =
      installed && installed !== latest
        ? `npm 最新版 ${latest} を参照 (インストール済みは ${installed})`
        : 'npm 最新版を参照';
    return { version: latest, note };
  }

  if (installed) return { version: installed };

  if (!isRegistryRange(dep.range)) {
    throw new Error(`レジストリ以外の依存指定 (${dep.range}) はバージョンを解決できません`);
  }

  const packument = await client.fetchPackument(dep.name);
  const versions = Object.keys(packument.versions ?? {});
  const range = dep.range === '' ? '*' : dep.range;
  const best =
    semver.maxSatisfying(versions, range, { includePrerelease: false }) ??
    (packument['dist-tags'] && packument['dist-tags'][range]);
  if (best) return { version: best, note: 'lock/node_modules 無しのためレジストリで範囲解決' };

  const latest = packument['dist-tags']?.latest;
  if (latest) return { version: latest, note: `範囲未解決 (${dep.range}) のため latest を使用` };
  throw new Error(`バージョンを解決できません (${dep.range})`);
}

/** git:, file:, http(s):, github ショートハンド等はレジストリで解決できない。 */
export function isRegistryRange(range) {
  const r = String(range).trim();
  if (r === '' || r === '*' || r === 'latest') return true;
  if (/^(git\+|git:|file:|https?:|ssh:|github:|gitlab:|bitbucket:|gist:|npm:)/.test(r)) return false;
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(r)) return false; // user/repo ショートハンド
  return semver.validRange(r) != null || /^[A-Za-z][\w.-]*$/.test(r); // dist-tag も許容
}

function repositoryUrl(manifest) {
  const repo = manifest.repository;
  if (!repo) return manifest.homepage ?? '';
  if (typeof repo === 'string') return repo;
  return repo.url ?? manifest.homepage ?? '';
}
