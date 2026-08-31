import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * npm レジストリ API クライアント。
 * - ファイルキャッシュ（.cache/）
 * - 429 / 5xx / ネットワークエラーの指数バックオフリトライ
 * - 同時実行数の制限
 */
export class RegistryClient {
  /**
   * @param {{ registryUrl?: string, cacheDir?: string | null, concurrency?: number, retries?: number, fetchImpl?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    this.registryUrl = (options.registryUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
    this.cacheDir = options.cacheDir ?? null;
    this.retries = options.retries ?? 3;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.limiter = createLimiter(options.concurrency ?? 5);
    this.stats = { requests: 0, cacheHits: 0 };
  }

  /** 特定バージョンのマニフェスト（package.json 相当）を取得する。 */
  async fetchManifest(name, version) {
    return this.getJson(`${encodePackageName(name)}/${encodeURIComponent(version)}`, `${safeFileName(name)}@${version}.json`);
  }

  /**
   * packument（全バージョン情報）を取得する。サイズ削減のため abbreviated 形式を要求する。
   * @param {{ fresh?: boolean }} [options] fresh=true でキャッシュを使わず常に取得する（dist-tags.latest が古くならないように）
   */
  async fetchPackument(name, { fresh = false } = {}) {
    return this.getJson(
      encodePackageName(name),
      fresh ? null : `${safeFileName(name)}.packument.json`,
      { Accept: 'application/vnd.npm.install-v1+json' },
    );
  }

  /** cacheFile が null のときはキャッシュを読み書きしない。 */
  async getJson(pathname, cacheFile, headers = {}) {
    const cached = cacheFile ? await this.readCache(cacheFile) : null;
    if (cached) {
      this.stats.cacheHits += 1;
      return cached;
    }
    const url = `${this.registryUrl}/${pathname}`;
    const data = await this.limiter(() => this.fetchWithRetry(url, headers));
    if (cacheFile) await this.writeCache(cacheFile, data);
    return data;
  }

  async fetchWithRetry(url, headers) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      this.stats.requests += 1;
      let response;
      try {
        response = await this.fetchImpl(url, { headers: { Accept: 'application/json', ...headers } });
      } catch (err) {
        if (attempt > this.retries) throw new Error(`ネットワークエラー: ${url} (${err.message})`);
        await sleep(backoff(attempt));
        continue;
      }
      if (response.ok) return response.json();
      if (response.status === 404) {
        throw new RegistryNotFoundError(url);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt > this.retries) {
        throw new Error(`HTTP ${response.status}: ${url}`);
      }
      await sleep(backoff(attempt));
    }
  }

  readCache(file) {
    return readJsonCache(this.cacheDir, file);
  }

  writeCache(file, data) {
    return writeJsonCache(this.cacheDir, file, data);
  }
}

/** cacheDir/file の JSON を読む。無い・壊れている・cacheDir が null なら null。 */
export async function readJsonCache(cacheDir, file) {
  if (!cacheDir) return null;
  try {
    return JSON.parse(await readFile(path.join(cacheDir, file), 'utf8'));
  } catch {
    return null;
  }
}

/** cacheDir/file に JSON を書く。失敗は致命的ではないので握りつぶす。 */
export async function writeJsonCache(cacheDir, file, data) {
  if (!cacheDir) return;
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, file), JSON.stringify(data), 'utf8');
  } catch {
    // キャッシュ書き込み失敗は無視する
  }
}

export class RegistryNotFoundError extends Error {
  constructor(url) {
    super(`レジストリに存在しません (404): ${url}`);
    this.name = 'RegistryNotFoundError';
  }
}

/** スコープ付きパッケージ名 (@scope/name) を @scope%2Fname にエンコードする。 */
export function encodePackageName(name) {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

export function safeFileName(name) {
  return name.replace(/[@/\\:*?"<>|]/g, '_');
}

function backoff(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同時実行数を制限する簡易リミッター。 */
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
