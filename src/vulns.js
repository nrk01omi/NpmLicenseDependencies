import semver from 'semver';

/**
 * ⑥ 脆弱性チェック。
 * npm レジストリの一括 advisories API（`npm audit` が使っているもの）に、name → [version...] をまとめて 1 回 POST し、
 * 各パッケージの脆弱性情報（GitHub Advisory の ID / URL / タイトル / 深刻度 / 影響バージョン / CVSS）を得る。
 * 認証は不要。応答には影響バージョン範囲が付くので、実際の版が該当するかは semver で照合して絞り込む。
 * 脆弱性情報は日々変わるため、この結果はキャッシュしない。
 */

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const BULK_PATH = '/-/npm/v1/security/advisories/bulk';
/** 深刻度の並び（高い順） */
export const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];
const CHUNK = 200;

export class VulnClient {
  /**
   * @param {{ registryUrl?: string, fetchImpl?: typeof fetch, retries?: number }} [options]
   */
  constructor(options = {}) {
    this.registryUrl = (options.registryUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.retries = options.retries ?? 2;
    this.stats = { requests: 0, packages: 0 };
  }

  /**
   * @param {Array<{ name: string, version: string }>} pkgs
   * @returns {Promise<Map<string, Advisory[]>>}  key は name@version。該当なしは空配列（要求したものはすべてキーが入る）
   */
  async lookup(pkgs) {
    const byName = new Map();
    for (const p of pkgs) {
      if (!p?.name || !p?.version || !semver.valid(p.version)) continue;
      if (!byName.has(p.name)) byName.set(p.name, new Set());
      byName.get(p.name).add(p.version);
    }
    const result = new Map();
    for (const [name, versions] of byName) for (const v of versions) result.set(`${name}@${v}`, []);
    const names = [...byName.keys()];
    for (let i = 0; i < names.length; i += CHUNK) {
      const chunk = names.slice(i, i + CHUNK);
      const body = Object.fromEntries(chunk.map((n) => [n, [...byName.get(n)]]));
      const data = await this.post(body);
      this.stats.packages += chunk.length;
      for (const name of chunk) {
        const list = Array.isArray(data[name]) ? data[name] : [];
        for (const version of byName.get(name)) {
          const hits = list.filter((a) => affects(a, version)).map(normalizeAdvisory);
          hits.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || String(a.id).localeCompare(String(b.id)));
          result.set(`${name}@${version}`, hits);
        }
      }
    }
    return result;
  }

  async post(body) {
    const url = `${this.registryUrl}${BULK_PATH}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      this.stats.requests += 1;
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (attempt > this.retries) throw new Error(`脆弱性 API に接続できません: ${url} (${err.message})`);
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt > this.retries) {
        throw new Error(`脆弱性 API が HTTP ${response.status} を返しました: ${url}`);
      }
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

/** @typedef {{ id: string, url: string, title: string, severity: string, vulnerableVersions: string, cvssScore: number|null, cwe: string[] }} Advisory */

function normalizeAdvisory(a) {
  const url = String(a.url ?? '');
  const ghsa = url.match(/GHSA-[0-9a-z-]+/i)?.[0];
  return {
    id: ghsa ?? String(a.id ?? ''),
    url,
    title: String(a.title ?? ''),
    severity: normalizeSeverity(a.severity),
    vulnerableVersions: String(a.vulnerable_versions ?? ''),
    cvssScore: typeof a.cvss?.score === 'number' ? a.cvss.score : null,
    cwe: Array.isArray(a.cwe) ? a.cwe : [],
  };
}

function normalizeSeverity(s) {
  const v = String(s ?? '').toLowerCase();
  if (v === 'medium') return 'moderate';
  return SEVERITY_ORDER.includes(v) ? v : 'info';
}

export function severityRank(severity) {
  const i = SEVERITY_ORDER.indexOf(severity);
  return i < 0 ? SEVERITY_ORDER.length : i;
}

/** advisory の影響バージョン範囲に version が含まれるか。範囲が読めない場合は含まれるとみなす（安全側）。 */
export function affects(advisory, version) {
  const range = advisory?.vulnerable_versions ?? advisory?.vulnerableVersions;
  if (!range || range === '*') return true;
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return true;
  }
}

/** 一覧の集計: { count, highest, bySeverity } */
export function summarizeVulns(list) {
  const bySeverity = {};
  for (const a of list ?? []) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
  const highest = SEVERITY_ORDER.find((s) => bySeverity[s]) ?? null;
  return { count: (list ?? []).length, highest, bySeverity };
}

/** CSV / 画面用の要約文: なし | あり 2 件 (最高 high; high 1, moderate 1) */
export function formatVulnSummary(list) {
  const s = summarizeVulns(list);
  if (s.count === 0) return 'なし';
  const parts = SEVERITY_ORDER.filter((k) => s.bySeverity[k]).map((k) => `${k} ${s.bySeverity[k]}`);
  return `あり ${s.count} 件 (最高 ${s.highest}; ${parts.join(', ')})`;
}

/** CSV 用の詳細: GHSA-xxxx [high] タイトル (影響: <4.17.19) https://github.com/advisories/GHSA-xxxx; ... */
export function formatVulnDetails(list) {
  return (list ?? [])
    .map((a) => `${a.id} [${a.severity}${a.cvssScore != null ? ` ${a.cvssScore}` : ''}] ${a.title}${a.vulnerableVersions ? ` (影響: ${a.vulnerableVersions})` : ''} ${a.url}`.trim())
    .join('; ');
}

/**
 * 結果行に脆弱性情報を付ける（ok な行のみ）。失敗しても行は落とさず vulnStatus='error' にする。
 * @returns {Promise<{ checked: number, withVulns: number, advisories: number, error: string|null }>}
 */
export async function attachVulnerabilities(rows, client) {
  const targets = rows.filter((r) => r && r.ok && r.version && semver.valid(r.version));
  const summary = { checked: 0, withVulns: 0, advisories: 0, error: null };
  if (targets.length === 0) return summary;
  try {
    const map = await client.lookup(targets.map((r) => ({ name: r.name, version: r.version })));
    for (const r of targets) {
      const list = map.get(`${r.name}@${r.version}`) ?? [];
      const s = summarizeVulns(list);
      r.vulns = list;
      r.vulnStatus = 'ok';
      r.vulnHighest = s.highest;
      summary.checked += 1;
      if (list.length) summary.withVulns += 1;
      summary.advisories += list.length;
    }
  } catch (err) {
    summary.error = err.message;
    for (const r of targets) {
      r.vulns = [];
      r.vulnStatus = 'error';
      r.vulnHighest = null;
      r.note = [r.note, `脆弱性確認失敗: ${err.message}`].filter(Boolean).join(' / ');
    }
  }
  return summary;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
