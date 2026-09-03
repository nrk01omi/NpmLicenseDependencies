import semver from 'semver';

import {
  loadProject,
  listDirectDependencies,
  listLockPackages,
  listLockRootDependencies,
  readInstalledVersion,
} from './project.js';
import { RegistryClient, RegistryNotFoundError } from './registry.js';
import { NpmSiteClient, siteUrl } from './npmsite.js';
import { VulnClient, attachVulnerabilities, formatVulnSummary, formatVulnDetails } from './vulns.js';
import { normalizeLicense } from './license.js';
import { parseCsv } from './csv.js';

export const CSV_HEADER = [
  'ライブラリ名',
  'バージョン',
  '依存種別',
  '取得元',
  '深さ',
  '要求元',
  '既出',
  '表示階層',
  '表示上の親',
  'ライセンス',
  '依存ライブラリ',
  '取得済みライブラリ',
  'npm サイトの dependencies',
  '一致状態',
  '脆弱性',
  '脆弱性の詳細',
  'リポジトリ',
  '備考',
];

/** 一致状態の値 */
export const MATCH = {
  ALL: '全一致',
  MISMATCH: '不一致',
  UNKNOWN: 'サイト未取得',
};

/** 依存種別: 直接依存は package.json のセクション名、再帰調査で見つかった推移的依存は 'transitive' */
export const DEP_TYPE_TRANSITIVE = 'transitive';

/**
 * 行のリストの作り方。
 *   union       — package.json 由来 ∪ package-lock.json 由来（OR で網羅。既定）
 *   packageJson — package.json 由来のみ（この機能を入れる前と同じ動き）
 */
export const LIST_MODES = ['union', 'packageJson'];

export function normalizeListMode(mode) {
  return LIST_MODES.includes(mode) ? mode : 'union';
}

/**
 * 取得元（その行がどちらのリストから来たか）。
 * 行のリストは package.json 由来と package-lock.json 由来の OR（和集合）で作る。
 */
export const SOURCE = {
  BOTH: '両方',
  PACKAGE_JSON: 'package.json',
  LOCK: 'package-lock.json',
};

/**
 * プロジェクト全体を解析する。CLI と Web UI の両方から使う。
 *
 * @param {object} options
 * @param {string} options.projectDir
 * @param {boolean} [options.includeDev]
 * @param {string|null} [options.cacheDir]  レジストリ応答のキャッシュ置き場（null で使わない）
 * @param {string|null} [options.siteCacheDir]  npm サイト応答のキャッシュ置き場（省略時は cacheDir と同じ。null で使わない）
 * @param {string|null} [options.profileBaseDir]  ブラウザプロファイルの置き場（キャッシュ設定に関係なく保持したいとき）
 * @param {string} [options.registryUrl]
 * @param {'installed'|'latest'} [options.versionMode]
 * @param {boolean} [options.useSite]  npm サイトの Dependencies 欄も取得して照合する（既定 true）
 * @param {string|null} [options.browserPath]  サイト取得に使うブラウザの実行ファイル（省略時は自動検出）
 * @param {{ min: number, max: number }} [options.siteWaitMs]  サイト取得ごとに入れる待ち時間の範囲（ミリ秒、ランダム）
 * @param {'cdp'|'playwright'} [options.siteEngine]  サイト取得のブラウザ操作方法（既定 cdp。playwright は playwright-core のインストールが必要）
 * @param {boolean} [options.recursive]  依存ライブラリを再帰的にたどり、推移的依存もすべて行にする（既定 false）
 * @param {'union'|'packageJson'} [options.listMode]  行のリストの作り方（既定 union = package.json ∪ package-lock.json）
 * @param {boolean} [options.includeLock]  listMode の代わりに真偽値で指定する場合（後方互換。false なら packageJson と同じ）
 * @param {(ev: { processed: number, total: number }) => void} [options.onDiscoverProgress]  再帰調査の進捗
 * @param {(ev: { nodes: object[], summary: object }) => Promise<boolean>|boolean} [options.onDiscovered]
 *   再帰調査が終わったときに呼ばれる。false を返すと本調査に入らず終了する（rows は空、aborted: true）。省略時は続行
 * @param {(ev: { project: object, deps: object[] }) => void} [options.onStart]  package.json を読み込んだ直後
 * @param {(ev: { targets: object[] }) => void} [options.onTargets]  本調査の対象（行数）が確定したとき
 * @param {(ev: { index: number, row: object, completed: number, total: number }) => void} [options.onProgress]
 * @param {(ev: { index: number, dep: object, row: object, attempt: number }) => Promise<'retry'|'ignore'>} [options.onError]
 *   取得に失敗したときに呼ばれる。'retry' を返すと同じ依存をもう一度取得し、'ignore' を返すと失敗行のまま次へ進む。
 *   省略時は 'ignore' 相当。
 * @param {(ev: { name: string, version: string, waitMs: number }) => void} [options.onSiteWait]  サイト取得前の待ちに入ったとき
 */
export async function analyze(options) {
  const {
    projectDir,
    includeDev = false,
    cacheDir = null,
    siteCacheDir = cacheDir,
    profileBaseDir = null,
    registryUrl,
    versionMode = 'installed',
    useSite = true,
    browserPath = null,
    siteWaitMs,
    siteEngine = 'cdp',
    recursive = false,
    listMode = 'union',
    includeLock = normalizeListMode(listMode) === 'union',
    useVulns = true,
    onDiscoverProgress,
    onDiscovered,
    onProgress,
    onStart,
    onTargets,
    onError,
    onSiteWait,
    onVulns,
  } = options;
  const project = await loadProject(projectDir);
  // 直接依存は package.json と package-lock.json のルート記録の OR（lock だけが知っている直接依存も拾う）
  const deps = mergeDirectDependencies(
    listDirectDependencies(project.packageJson, { includeDev }),
    includeLock ? listLockRootDependencies(project.lock, { includeDev }) : [],
  );
  onStart?.({ project, deps });

  const client = new RegistryClient({ registryUrl, cacheDir });

  let targets = deps;
  let nodes = null;
  let summary = null;
  if (recursive) {
    nodes = await discoverDependencies(project, deps, client, { versionMode, onProgress: onDiscoverProgress });
    // package.json からたどれなかった lock 上のライブラリを足す（OR）。再帰調査の件数確認にも含める
    if (includeLock) nodes = mergeLockPackages(nodes, project, { includeDev, matchByName: false });
    summary = summarizeNodes(nodes);
    const proceed = onDiscovered ? await onDiscovered({ nodes, summary }) : true;
    if (!proceed) {
      return { project, deps, rows: [], nodes, summary, aborted: true, stats: { ...client.stats, site: null } };
    }
    targets = nodes;
  } else if (includeLock) {
    // 非再帰でも、lock に載っているライブラリはすべて行にする（直接依存 OR lock）
    targets = mergeLockPackages(deps, project, { includeDev, matchByName: true });
  } else {
    targets = markSources(deps, project, { includeDev });
  }
  onTargets?.({ targets });

  const site = useSite
    ? new NpmSiteClient({ cacheDir: siteCacheDir, profileBaseDir, browserPath, waitMs: siteWaitMs, onWait: onSiteWait, engine: siteEngine })
    : null;
  const rows = new Array(targets.length);
  let completed = 0;
  try {
    await Promise.all(
      targets.map(async (dep, index) => {
        rows[index] = await buildRowWithRetry(dep, index, project, client, onError, { versionMode, site });
        completed += 1;
        onProgress?.({ index, row: rows[index], completed, total: targets.length });
      }),
    );
  } finally {
    await site?.close();
  }
  // ⑥ 脆弱性: 全行まとめて 1 回で問い合わせる（キャッシュしない）
  let vulnStats = null;
  if (useVulns) {
    const vulnClient = new VulnClient({ registryUrl });
    vulnStats = await attachVulnerabilities(rows, vulnClient);
    vulnStats.requests = vulnClient.stats.requests;
    onVulns?.(vulnStats);
  }
  return {
    project,
    deps,
    rows,
    nodes,
    summary,
    aborted: false,
    stats: { ...client.stats, site: site ? site.stats : null, vulns: vulnStats },
  };
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
 * 1 つの依存について、バージョンを解決し、レジストリからマニフェストを取得して結果行を組み立てる。
 * 失敗しても行は落とさず ok=false で返す。
 *
 * @param {{ name: string, range: string, depType: string, version?: string|null, lockPath?: string[]|null, depth?: number, parents?: string[], note?: string }} dep
 *   version が指定されていればそれを使う（再帰調査で解決済みのノード）。無ければ resolveVersion で決める
 * @param {{ versionMode?: 'installed' | 'latest', site?: NpmSiteClient | null }} [rowOptions]
 *   installed: package-lock / node_modules のバージョン（実際に使っているもの）
 *   latest:    npm レジストリの最新版（npm サイトのパッケージページの既定表示と同じ）
 *   site:      渡すと npm サイトの Dependencies 欄も取得して 3 者の件数を照合する
 */
export async function buildRow(dep, project, client, rowOptions = {}) {
  const { site = null } = rowOptions;
  const resolver = lockResolverOf(project);
  const notes = [];
  const base = {
    name: dep.name,
    depType: dep.depType,
    source: dep.source ?? SOURCE.PACKAGE_JSON,
    depth: dep.depth ?? 0,
    parents: dep.parents ?? [],
  };
  let version = dep.version ?? null;
  let lockPath = dep.lockPath ?? null;
  let manifest = null;

  try {
    if (version) {
      if (dep.note) notes.push(dep.note);
    } else {
      const resolved = await resolveVersion(dep, project, client, rowOptions);
      version = resolved.version;
      lockPath = resolved.fromLock ? [dep.name] : null;
      if (resolved.note) notes.push(resolved.note);
    }
    manifest = await client.fetchManifest(dep.name, version);
  } catch (err) {
    const message = err instanceof RegistryNotFoundError ? err.message : `取得失敗: ${err.message}`;
    notes.push(message);
    return {
      ...base,
      ok: false,
      version: version ?? dep.range,
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
      note: notes.join(' / '),
    };
  }

  const deps = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  const depNames = Object.keys(deps).sort();
  const dependencies = depNames.map((n) => `${n}@${deps[n]}`);
  // 取得済みライブラリ: この行の lock 上の位置を起点に、Node の解決順（親の直下 → 祖先 → トップレベル）で引く
  const dependenciesResolved = [];
  const missing = [];
  for (const n of depNames) {
    const r = resolver.resolve(n, lockPath ?? []);
    if (r) dependenciesResolved.push(`${n}@${r.version}`);
    else missing.push(n);
  }
  if (depNames.length > 0 && resolver.size > 0) {
    if (missing.length > 0) notes.push(`lock 未解決: ${missing.join(', ')}`);
  } else if (depNames.length > 0 && !project.lock) {
    notes.push('package-lock.json 無し');
  }

  const resolvedVersion = manifest.version ?? version;
  let siteDependencies = [];
  let siteStatus = 'skipped';
  let siteUrlValue = '';
  let match = '';
  let counts = null;
  if (site) {
    const result = await site.fetchDependencies(dep.name, resolvedVersion);
    siteUrlValue = result.url;
    if (result.ok) {
      siteStatus = 'ok';
      siteDependencies = result.names;
      if (result.count != null && result.count !== result.names.length) {
        notes.push(`npm サイトの見出し件数 ${result.count} とリンク数 ${result.names.length} が不一致`);
      }
    } else {
      siteStatus = 'error';
      notes.push(`npm サイト取得失敗: ${result.error}`);
    }
    counts = { dependencies: depNames.length, resolved: dependenciesResolved.length, site: siteDependencies.length };
    match = compareCounts(counts, siteStatus);
    const diff = describeDifference(depNames, siteDependencies, siteStatus);
    if (diff) notes.push(diff);
  }

  return {
    ...base,
    ok: true,
    version: resolvedVersion,
    license: normalizeLicense(manifest),
    dependencies,
    dependenciesResolved,
    siteDependencies,
    siteStatus,
    siteUrl: siteUrlValue,
    match,
    counts,
    vulns: [],
    vulnStatus: 'skipped',
    vulnHighest: null,
    repository: repositoryUrl(manifest),
    note: notes.join(' / '),
  };
}

/** 3 者の件数を比べて一致状態を返す。 */
export function compareCounts(counts, siteStatus) {
  if (siteStatus !== 'ok') return MATCH.UNKNOWN;
  return counts.dependencies === counts.resolved && counts.resolved === counts.site ? MATCH.ALL : MATCH.MISMATCH;
}

/** 依存ライブラリと npm サイトの名前の差分を備考用にまとめる（lock との差は「lock 未解決」で別途出る）。 */
function describeDifference(depNames, siteNames, siteStatus) {
  if (siteStatus !== 'ok') return '';
  const parts = [];
  const onlyInSite = siteNames.filter((n) => !depNames.includes(n));
  const onlyInDeps = depNames.filter((n) => !siteNames.includes(n));
  if (onlyInSite.length) parts.push(`サイトのみ: ${onlyInSite.join(', ')}`);
  if (onlyInDeps.length) parts.push(`依存ライブラリのみ: ${onlyInDeps.join(', ')}`);
  return parts.join(' / ');
}

/** 結果行を CSV の 1 行（セル配列）に変換する。 */
export function rowToCells(row) {
  return [
    row.name,
    row.version,
    row.depType,
    row.source ?? SOURCE.PACKAGE_JSON,
    String(row.depth ?? 0),
    (row.parents ?? []).join('; '),
    row.dup ? '既出' : '',
    row.level != null ? String(row.level) : '',
    row.treeParent ?? '',
    row.license,
    row.dependencies.join('; '),
    row.dependenciesResolved.join('; '),
    (row.siteDependencies ?? []).join('; '),
    row.match ?? '',
    vulnCell(row),
    row.vulnStatus === 'ok' ? formatVulnDetails(row.vulns) : '',
    row.repository,
    row.note,
  ];
}

/** ⑥ 脆弱性列の値: 未確認は空、確認失敗は '確認失敗'、確認済みは 'なし' か 'あり N 件 (最高 …)' */
export function vulnCell(row) {
  if (row.vulnStatus === 'ok') return formatVulnSummary(row.vulns);
  if (row.vulnStatus === 'error') return '確認失敗';
  return '';
}

// ---------------------------------------------------------------- CSV の読み込み（保存した結果の復元）

/**
 * 保存した CSV（toCsv(CSV_HEADER, rows.map(rowToCells)) の出力）を結果行に戻す。
 * 列は見出し名で対応付けるので、列が少ない古い形式の CSV でもある列だけで復元できる。
 * @param {string} text  CSV 全文（BOM 可）
 * @returns {{ rows: object[], header: string[], missing: string[], skippedDuplicates: number }}
 *   missing は無かった列名、skippedDuplicates は落とした「既出」行の数
 */
export function rowsFromCsv(text) {
  const table = parseCsv(text);
  if (table.length === 0) throw new Error('CSV が空です');
  const header = table[0].map((h) => h.trim());
  if (!header.includes('ライブラリ名')) throw new Error('このツールが保存した CSV ではありません（「ライブラリ名」列がありません）');
  const idx = new Map(header.map((h, i) => [h, i]));
  const get = (cells, name) => (idx.has(name) ? (cells[idx.get(name)] ?? '') : '');
  // 「既出」行は画面表示のための重複なので、復元時は落とす（表側で親子順に展開し直すため）
  const body = table.slice(1).filter((cells) => get(cells, '既出') === '');
  const skippedDuplicates = table.length - 1 - body.length;
  const rows = body.map((cells) => cellsToRow(cells, get));
  const missing = CSV_HEADER.filter((h) => !idx.has(h));
  return { rows, header, missing, skippedDuplicates };
}

function cellsToRow(cells, get) {
  const list = (s) => (s ? s.split('; ').filter(Boolean) : []);
  const license = get(cells, 'ライセンス');
  const ok = license !== '取得失敗';
  const vulnText = get(cells, '脆弱性');
  const vulns = parseVulnDetails(get(cells, '脆弱性の詳細'));
  const vulnStatus = vulnText === '' ? 'skipped' : vulnText === '確認失敗' ? 'error' : 'ok';
  const siteText = get(cells, 'npm サイトの dependencies');
  const match = get(cells, '一致状態');
  const siteDependencies = list(siteText);
  const siteStatus = match === '' ? 'skipped' : match === MATCH.UNKNOWN ? 'error' : 'ok';
  const dependencies = list(get(cells, '依存ライブラリ'));
  const dependenciesResolved = list(get(cells, '取得済みライブラリ'));
  const name = get(cells, 'ライブラリ名');
  const version = get(cells, 'バージョン');
  return {
    ok,
    name,
    version,
    depType: get(cells, '依存種別') || 'dependencies',
    source: get(cells, '取得元') || SOURCE.PACKAGE_JSON,
    depth: Number.parseInt(get(cells, '深さ'), 10) || 0,
    parents: list(get(cells, '要求元')),
    license,
    dependencies,
    dependenciesResolved,
    siteDependencies,
    siteStatus,
    siteUrl: siteStatus === 'skipped' || !name || !version ? '' : siteUrl(name, version),
    match,
    counts: match ? { dependencies: dependencies.length, resolved: dependenciesResolved.length, site: siteDependencies.length } : null,
    vulns,
    vulnStatus,
    vulnHighest: vulns[0]?.severity ?? (vulnText.match(/最高 (\w+)/)?.[1] ?? null),
    repository: get(cells, 'リポジトリ'),
    note: get(cells, '備考'),
  };
}

/** formatVulnDetails の逆変換: 'GHSA-x [high 7.4] title (影響: <2) https://…; …' → advisory 配列 */
export function parseVulnDetails(text) {
  if (!text) return [];
  const items = text.split(/; (?=\S+ \[)/);
  const out = [];
  for (const item of items) {
    const m = item.trim().match(/^(\S+) \[(\w+)(?: ([\d.]+))?\] (.*?)(?: \(影響: (.*?)\))? (https?:\/\/\S+)$/);
    if (m) {
      out.push({ id: m[1], severity: m[2], cvssScore: m[3] != null ? Number(m[3]) : null, title: m[4], vulnerableVersions: m[5] ?? '', url: m[6], cwe: [] });
    } else {
      out.push({ id: item.trim().slice(0, 40), severity: 'info', cvssScore: null, title: item.trim(), vulnerableVersions: '', url: '', cwe: [] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 再帰調査

/**
 * 直接依存を起点に「依存ライブラリ」（レジストリ上の dependencies）を再帰的にたどり、
 * 到達したすべての name@version をノードとして列挙する（本調査の前段。ライセンスやサイト照合はしない）。
 *
 * 子のバージョン決定は「依存ライブラリベース」:
 *   1. package-lock.json を Node の解決順で引く（親の直下 → 祖先 → トップレベル）
 *   2. lock に無ければ、レジストリの全バージョンから要求範囲を満たす最大のもの（semver）
 * 同じ name@version は 1 ノードにまとめ、要求元（parents）を集約する。循環はこれで止まる。
 *
 * @returns {Promise<Array<{ name, version, range, depType, depth, parents: string[], lockPath: string[]|null, note: string, error?: string, unresolved?: string[] }>>}
 */
export async function discoverDependencies(project, deps, client, { versionMode = 'installed', onProgress } = {}) {
  const resolver = lockResolverOf(project);
  const nodes = new Map();
  let queue = [];
  let processed = 0;

  const addNode = (name, version, { range, depType, depth, parent, lockPath, note }) => {
    const key = `${name}@${version}`;
    const existing = nodes.get(key);
    if (existing) {
      if (parent && !existing.parents.includes(parent)) existing.parents.push(parent);
      if (depth < existing.depth) existing.depth = depth;
      return existing;
    }
    const node = { name, version, range, depType, depth, parents: parent ? [parent] : [], lockPath, note: note ?? '' };
    nodes.set(key, node);
    queue.push(node);
    return node;
  };

  // 起点: 直接依存（バージョンの決め方は本調査と同じ）
  for (const dep of deps) {
    try {
      const r = await resolveVersion(dep, project, client, { versionMode });
      addNode(dep.name, r.version, { range: dep.range, depType: dep.depType, depth: 0, parent: null, lockPath: r.fromLock ? [dep.name] : null, note: r.note });
    } catch (err) {
      // バージョンが決まらない直接依存も行として残す（本調査で取得失敗になる）
      const node = { name: dep.name, version: null, range: dep.range, depType: dep.depType, depth: 0, parents: [], lockPath: null, note: '', error: err.message };
      nodes.set(`${dep.name}@${dep.range}`, node);
    }
  }

  // 幅優先。同じ深さのノードはまとめて並列に取得する（並列数はレジストリクライアント側で制限）
  while (queue.length > 0) {
    const batch = queue;
    queue = [];
    await Promise.all(
      batch.map(async (node) => {
        let manifest;
        try {
          manifest = await client.fetchManifest(node.name, node.version);
        } catch (err) {
          node.error = err.message;
          processed += 1;
          onProgress?.({ processed, total: nodes.size });
          return;
        }
        const children = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
        for (const [childName, range] of Object.entries(children)) {
          const child = await resolveChildVersion(childName, String(range), node, client, resolver);
          if (!child) {
            node.unresolved = [...(node.unresolved ?? []), childName];
            continue;
          }
          addNode(childName, child.version, {
            range: String(range),
            depType: DEP_TYPE_TRANSITIVE,
            depth: node.depth + 1,
            parent: `${node.name}@${node.version}`,
            lockPath: child.lockPath,
            note: child.note,
          });
        }
        processed += 1;
        onProgress?.({ processed, total: nodes.size });
      }),
    );
  }

  const list = [...nodes.values()];
  list.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  return list;
}

/** 並び順の選択肢: depth = 深さ順（直接依存 → 深さ 1 → …、同じ深さは名前順）、tree = 親子順（親の直下に子・孫） */
export const ROW_ORDERS = ['tree', 'depth'];

export function normalizeOrder(order) {
  return ROW_ORDERS.includes(order) ? order : 'tree';
}

/**
 * 親子順（ツリー）に並べる。直接依存（深さ 0）を元の順のまま根とし、その下に子を名前順で深さ優先にぶら下げる。
 * 再帰調査でない結果（全行が深さ 0）では元の順のまま。null（取得中）の行は末尾に残す。
 *
 * @param {object[]} rows
 * @param {{ expandDuplicates?: boolean }} [options]
 *   false（既定）: 複数の親から要求される行は最初に現れた位置にだけ出す（1 行 1 パッケージ）
 *   true         : 画面と同じ展開。2 回目以降も親の下に出し、行のコピーに dup / level / treeParent を付ける
 *                  （既出の行の下に子は展開しない）
 */
export function orderRowsTree(rows, options = {}) {
  const { expandDuplicates = false } = options;
  const key = (r) => `${r.name}@${r.version}`;
  const children = new Map();
  const roots = [];
  const pending = [];
  for (const r of rows) {
    if (!r) {
      pending.push(r);
      continue;
    }
    if ((r.depth ?? 0) === 0 || !(r.parents?.length > 0)) roots.push(r);
    for (const p of r.parents ?? []) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(r);
    }
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  const seen = new Set();
  const visit = (r, level, parent) => {
    const k = key(r);
    if (seen.has(k)) {
      if (expandDuplicates) out.push({ ...r, dup: true, level, treeParent: parent }); // 既出: 出すが下は展開しない
      return;
    }
    seen.add(k);
    out.push(expandDuplicates ? { ...r, dup: false, level, treeParent: parent } : r);
    for (const c of children.get(k) ?? []) visit(c, level + 1, k);
  };
  for (const r of roots) visit(r, 0, '');
  for (const r of rows) if (r && !seen.has(key(r))) visit(r, 0, ''); // どの根からも届かない行（念のため）
  return [...out, ...pending];
}

/**
 * 指定の並び順で行を並べる。
 * @param {{ expandDuplicates?: boolean }} [options]  親子順のとき、既出（複数の親を持つ行）も画面と同じように繰り返し出す
 */
export function orderRows(rows, order, options = {}) {
  if (normalizeOrder(order) === 'tree') return orderRowsTree(rows, options);
  const list = rows.filter(Boolean);
  list.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.name.localeCompare(b.name));
  return [...list, ...rows.filter((r) => !r)];
}

/** 再帰調査の結果を集計する。 */
export function summarizeNodes(nodes) {
  const direct = nodes.filter((n) => n.depth === 0).length;
  const failed = nodes.filter((n) => n.error).length;
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const unresolved = nodes.reduce((m, n) => m + (n.unresolved?.length ?? 0), 0);
  const fromLock = nodes.filter((n) => n.lockPath).length;
  const lockOnly = nodes.filter((n) => n.source === SOURCE.LOCK).length;
  return { total: nodes.length, direct, transitive: nodes.length - direct, failed, maxDepth, unresolved, fromLock, lockOnly };
}

// ---------------------------------------------------------------- リストの OR（package.json ∪ package-lock.json）

/**
 * package.json の直接依存と、package-lock.json のルートに記録された直接依存をマージする（OR）。
 * 同じ名前は 1 件にまとめ、取得元を「両方」にする。
 */
export function mergeDirectDependencies(fromPackageJson, fromLockRoot = []) {
  const out = [];
  const index = new Map();
  for (const d of fromPackageJson) {
    const dep = { ...d, source: SOURCE.PACKAGE_JSON };
    index.set(d.name, dep);
    out.push(dep);
  }
  for (const d of fromLockRoot) {
    const existing = index.get(d.name);
    if (existing) {
      existing.source = SOURCE.BOTH;
      continue;
    }
    const dep = { ...d, source: SOURCE.LOCK, note: 'package.json に無く package-lock.json のルートにのみある直接依存' };
    index.set(d.name, dep);
    out.push(dep);
  }
  return out;
}

/** package-lock.json 上の name@version と name の集合を作る（取得元の判定用。dev も含めて見る）。 */
function lockMembership(project) {
  const keys = new Set();
  const names = new Set();
  for (const p of listLockPackages(project.lock, { includeDev: true })) {
    keys.add(`${p.name}@${p.version}`);
    names.add(p.name);
  }
  return { keys, names };
}

/**
 * 既存のターゲット（package.json 由来）に取得元を付ける。lock にも同じものがあれば「両方」。
 * 配列はそのまま（各要素に source を書き込む）返す。
 */
export function markSources(targets, project) {
  const { keys, names } = lockMembership(project);
  for (const t of targets) {
    if (t.source === SOURCE.LOCK) continue;
    const inLock = t.version ? keys.has(`${t.name}@${t.version}`) : names.has(t.name);
    t.source = inLock ? SOURCE.BOTH : SOURCE.PACKAGE_JSON;
  }
  return targets;
}

/**
 * package.json 由来のターゲットに、package-lock.json にしか無いライブラリを足す（OR で網羅する）。
 * 既存要素には取得元を書き込み、追加分は取得元 'package-lock.json' の新しいターゲットにする。
 *
 * @param {object[]} targets  package.json 由来のターゲット（直接依存 or 再帰調査のノード）
 * @param {object} project  loadProject の戻り値
 * @param {{ includeDev?: boolean, matchByName?: boolean }} [options]
 *   matchByName=true のときは名前だけで既出判定する（バージョン未解決の直接依存リストに足す場合）
 */
export function mergeLockPackages(targets, project, options = {}) {
  const { includeDev = false, matchByName = false } = options;
  const list = markSources(targets, project);
  const lockPkgs = listLockPackages(project.lock, { includeDev });
  if (lockPkgs.length === 0) return list;

  const seenKeys = new Set();
  const seenNames = new Set();
  for (const t of list) {
    if (t.version) seenKeys.add(`${t.name}@${t.version}`);
    seenNames.add(t.name);
  }
  for (const p of lockPkgs) {
    const key = `${p.name}@${p.version}`;
    if (seenKeys.has(key) || (matchByName && seenNames.has(p.name))) continue;
    seenKeys.add(key);
    seenNames.add(p.name);
    list.push({
      name: p.name,
      version: p.version,
      range: '',
      depType: DEP_TYPE_TRANSITIVE,
      source: SOURCE.LOCK,
      depth: p.lockPath.length - 1,
      parents: [],
      lockPath: p.lockPath,
      note: `package-lock.json のみ（node_modules/${p.lockPath.join('/node_modules/')}）`,
    });
  }
  return list;
}

/** 子依存 (name, range) のバージョンを、親の lock 上の位置を起点に決める。決められなければ null。 */
async function resolveChildVersion(name, range, parentNode, client, resolver) {
  const fromLock = resolver.resolve(name, parentNode.lockPath ?? []);
  if (fromLock) return { version: fromLock.version, lockPath: fromLock.path, note: '' };
  if (!isRegistryRange(range)) return null;
  try {
    const packument = await client.fetchPackument(name);
    const versions = Object.keys(packument.versions ?? {});
    const r = range === '' ? '*' : range;
    const best =
      semver.maxSatisfying(versions, r, { includePrerelease: false }) ??
      (packument['dist-tags'] && packument['dist-tags'][r]) ??
      packument['dist-tags']?.latest;
    if (!best) return null;
    return { version: best, lockPath: null, note: 'lock に無いためレジストリで範囲解決' };
  } catch {
    return null;
  }
}

/** project.lockResolver が無い（テスト用の簡易 project など）場合は lockVersions からトップレベルのみのリゾルバを作る。 */
function lockResolverOf(project) {
  if (project.lockResolver) return project.lockResolver;
  const map = project.lockVersions ?? new Map();
  return { size: map.size, resolve: (name) => (map.has(name) ? { version: map.get(name), path: [name] } : null) };
}

/**
 * レジストリに問い合わせる正確なバージョンを決める。
 * versionMode = 'installed'（既定）: package-lock → node_modules → packument から semver.maxSatisfying → dist-tags.latest
 * versionMode = 'latest'          : 常に dist-tags.latest（npm サイトの既定表示と同じ）。インストール済みと違えば備考に記す
 * @returns {Promise<{ version: string, note?: string, fromLock: boolean }>} fromLock は lock / node_modules で決まったとき true
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
    return { version: latest, note, fromLock: Boolean(installed) && installed === latest };
  }

  if (installed) return { version: installed, fromLock: true };

  if (!isRegistryRange(dep.range)) {
    throw new Error(`レジストリ以外の依存指定 (${dep.range}) はバージョンを解決できません`);
  }

  const packument = await client.fetchPackument(dep.name);
  const versions = Object.keys(packument.versions ?? {});
  const range = dep.range === '' ? '*' : dep.range;
  const best =
    semver.maxSatisfying(versions, range, { includePrerelease: false }) ??
    (packument['dist-tags'] && packument['dist-tags'][range]);
  if (best) return { version: best, note: 'lock/node_modules 無しのためレジストリで範囲解決', fromLock: false };

  const latest = packument['dist-tags']?.latest;
  if (latest) return { version: latest, note: `範囲未解決 (${dep.range}) のため latest を使用`, fromLock: false };
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
