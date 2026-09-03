#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, rowToCells, orderRows, CSV_HEADER, MATCH, DEP_TYPE_TRANSITIVE, ROW_ORDERS } from './analyze.js';
import { DEFAULT_WAIT_MS, SITE_ENGINES } from './npmsite.js';
import { toCsv } from './csv.js';

const THIS_FILE = fileURLToPath(import.meta.url);
export const TOOL_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
export const DEFAULT_CACHE_DIR = path.join(TOOL_ROOT, '.cache');

const USAGE = `使い方: node src/cli.js [--project <dir>] [--out <file.csv>] [--include-dev] [--latest] [--no-site] [--no-cache]

  --project <dir>    対象プロジェクト（package.json のあるディレクトリ）。既定: カレントディレクトリ
  --out <file>       出力 CSV パス。既定: <project>/npm-dependencies.csv
  --include-dev      devDependencies も対象に含める
  --latest           インストール済みではなく npm の最新版を参照する（npm サイトの表示と同じ）
  --list <mode>      行のリストの作り方: union（既定。package.json ∪ package-lock.json の OR で網羅）| package-json（package.json 由来のみ。従来どおり）
  --no-lock          --list package-json と同じ（package-lock.json にしか無いライブラリを行に加えない）
  --recursive        依存ライブラリを再帰的にたどり、推移的依存もすべて行にする。先に再帰調査で件数を出し、確認してから本調査に入る
  --yes              --recursive の件数確認を省略して本調査に進む（バッチ用。端末でない場合は自動で進む）
  --order <o>        CSV の並び順: tree（既定。親子順＝直接依存の直下に子・孫）| depth（深さ順、同じ深さは名前順）
  --no-duplicates    親子順のとき、複数の親から要求される行を最初の位置に 1 行だけ出す（既定は画面と同じく「既出」行も出す）
  --no-vulns         ⑥ 脆弱性チェック（npm の advisories API）を行わない（「脆弱性」「脆弱性の詳細」列は空になる）
  --no-site         npm サイト (npmjs.com) の Dependencies 欄を取得しない（「npm サイトの dependencies」「一致状態」列は空になる）
  --site-wait <a-b>  npm サイト取得ごとの待ち時間の範囲（秒、ランダム）。既定: ${DEFAULT_WAIT_MS.min / 1000}-${DEFAULT_WAIT_MS.max / 1000}。例: --site-wait 2-5、--site-wait 0 で待たない
  --site-engine <e>  npm サイト取得のブラウザ操作方法: cdp（既定、追加パッケージ不要）| playwright（要 npm install playwright-core）
  --browser <path>   npm サイト取得に使う Edge / Chrome の実行ファイル。既定: 自動検出（環境変数 NLD_BROWSER でも指定可）
  --no-cache         レジストリ応答のキャッシュ(.cache/<名前>@<版>.json)を使わず常に取得する
  --no-site-cache    npm サイト応答のキャッシュ(.cache/<名前>@<版>.npmsite.json)を使わず常にサイトから取得する
  --registry <url>   レジストリ URL。既定: https://registry.npmjs.org
  --help             このヘルプを表示

GUI で操作したい場合は  node src/server.js  を実行してください。
`;

/** "1-3" / "2" / "0" のような指定を { min, max }（ミリ秒）にする。 */
export function parseWaitSeconds(text) {
  if (text == null || text === '') return undefined;
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
  if (!m) throw new Error(`--site-wait の形式が不正です: ${text}（例: 1-3, 2, 0）`);
  const min = Number(m[1]) * 1000;
  const max = m[2] != null ? Number(m[2]) * 1000 : min;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string', default: '.' },
      out: { type: 'string' },
      'include-dev': { type: 'boolean', default: false },
      latest: { type: 'boolean', default: false },
      list: { type: 'string' },
      'no-lock': { type: 'boolean', default: false },
      recursive: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      order: { type: 'string', default: 'tree' },
      'no-duplicates': { type: 'boolean', default: false },
      'no-vulns': { type: 'boolean', default: false },
      'no-site': { type: 'boolean', default: false },
      'site-wait': { type: 'string' },
      'site-engine': { type: 'string', default: 'cdp' },
      browser: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      'no-site-cache': { type: 'boolean', default: false },
      registry: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const useSite = !values['no-site'];
  const siteWaitMs = parseWaitSeconds(values['site-wait']);
  const siteEngine = values['site-engine'];
  if (!SITE_ENGINES.includes(siteEngine)) throw new Error(`--site-engine は ${SITE_ENGINES.join(' | ')} のいずれかを指定してください: ${siteEngine}`);
  const listArg = values.list ?? (values['no-lock'] ? 'package-json' : 'union');
  if (!['union', 'package-json'].includes(listArg)) throw new Error(`--list は union | package-json のいずれかを指定してください: ${listArg}`);
  const listMode = listArg === 'union' ? 'union' : 'packageJson';
  const order = values.order;
  if (!ROW_ORDERS.includes(order)) throw new Error(`--order は ${ROW_ORDERS.join(' | ')} のいずれかを指定してください: ${order}`);

  let outPath = values.out ? path.resolve(values.out) : null;
  const result = await analyze({
    projectDir: values.project,
    includeDev: values['include-dev'],
    cacheDir: values['no-cache'] ? null : DEFAULT_CACHE_DIR,
    siteCacheDir: values['no-site-cache'] ? null : DEFAULT_CACHE_DIR,
    profileBaseDir: DEFAULT_CACHE_DIR,
    registryUrl: values.registry,
    versionMode: values.latest ? 'latest' : 'installed',
    useSite,
    browserPath: values.browser ?? null,
    siteWaitMs,
    siteEngine,
    recursive: values.recursive,
    listMode,
    useVulns: !values['no-vulns'],
    onStart: ({ project, deps }) => {
      outPath ??= path.join(project.root, 'npm-dependencies.csv');
      process.stderr.write(
        `対象: ${project.root}\n直接依存 ${deps.length} 件 (lock: ${project.lock ? 'あり' : 'なし'}, 参照: ${values.latest ? 'npm 最新版' : 'インストール済み'}, npm サイト照合: ${useSite ? `あり (${siteEngine})` : 'なし'}, 再帰: ${values.recursive ? 'あり' : 'なし'}, リスト: ${listMode === 'union' ? 'package.json ∪ package-lock.json' : 'package.json のみ'})\n`,
      );
      if (values.recursive) process.stderr.write('再帰調査を開始します（依存ライブラリをたどって推移的依存を列挙）…\n');
    },
    onDiscoverProgress: ({ processed, total }) => {
      if (processed % 25 === 0 || processed === total) process.stderr.write(`  再帰調査: ${processed} / ${total} 件を確認\n`);
    },
    onDiscovered: async ({ summary }) => {
      process.stderr.write(
        `再帰調査 完了: 合計 ${summary.total} 件 (直接 ${summary.direct} 件, 推移的 ${summary.transitive} 件, lock のみ ${summary.lockOnly ?? 0} 件, 最大深さ ${summary.maxDepth}, lock で決定 ${summary.fromLock} 件, 解決不能 ${summary.unresolved} 件, 取得失敗 ${summary.failed} 件)\n`,
      );
      if (useSite) {
        const avgWaitSec = ((siteWaitMs?.min ?? DEFAULT_WAIT_MS.min) + (siteWaitMs?.max ?? DEFAULT_WAIT_MS.max)) / 2000;
        const minutes = Math.ceil((summary.total * (avgWaitSec + 3)) / 60);
        process.stderr.write(`  npm サイト照合ありのため、本調査は最大でおよそ ${minutes} 分かかる見込みです（キャッシュ済みの分は除く）\n`);
      }
      if (values.yes || !process.stdin.isTTY) return true;
      return confirm('本調査（ライセンス取得・npm サイト照合）を開始しますか? [y/N] ');
    },
    onTargets: ({ targets }) => {
      process.stderr.write(`本調査: ${targets.length} 件を処理します\n`);
    },
    onProgress: ({ row, completed, total }) => {
      const tag = row.ok ? 'OK' : 'NG';
      const kind = row.depType === DEP_TYPE_TRANSITIVE ? ` (深さ ${row.depth})` : '';
      const extra = row.ok ? `${row.license}${row.match ? `  ${row.match}` : ''}` : row.note;
      process.stderr.write(`[${completed}/${total}] ${tag}  ${row.name}@${row.version}${kind}  ${extra}\n`);
    },
  });
  if (result.aborted) {
    process.stderr.write('本調査は中止しました（CSV は出力していません）\n');
    return 3;
  }

  const expandDuplicates = !values['no-duplicates'];
  const csvRows = orderRows(result.rows, order, { expandDuplicates });
  await writeFile(outPath, toCsv(CSV_HEADER, csvRows.map(rowToCells)), 'utf8');

  const failed = result.rows.filter((r) => !r.ok).length;
  const dupRows = csvRows.filter((r) => r.dup).length;
  const lines = [
    `完了: ${result.rows.length} 件 (取得失敗 ${failed} 件, レジストリ要求 ${result.stats.requests} 回, キャッシュ ${result.stats.cacheHits} 件)`,
  ];
  if (useSite) {
    const count = (m) => result.rows.filter((r) => r.match === m).length;
    const s = result.stats.site ?? { requests: 0, cacheHits: 0, waitedMs: 0 };
    lines.push(
      `npm サイト照合: ${MATCH.ALL} ${count(MATCH.ALL)} 件, ${MATCH.MISMATCH} ${count(MATCH.MISMATCH)} 件, ${MATCH.UNKNOWN} ${count(MATCH.UNKNOWN)} 件 (サイト取得 ${s.requests} 回, キャッシュ ${s.cacheHits} 件, 待ち合計 ${(s.waitedMs / 1000).toFixed(1)} 秒)`,
    );
  }
  if (result.stats.vulns) {
    const v = result.stats.vulns;
    lines.push(
      v.error
        ? `脆弱性チェック: 失敗 (${v.error})`
        : `脆弱性チェック: 確認 ${v.checked} 件, 脆弱性あり ${v.withVulns} 件 (advisory 合計 ${v.advisories} 件, API 要求 ${v.requests} 回)`,
    );
  }
  lines.push(`出力: ${outPath} (${csvRows.length} 行${dupRows ? `, うち既出 ${dupRows} 行` : ''})`);
  process.stderr.write(lines.join('\n') + '\n');
  return failed > 0 ? 2 : 0;
}

/** 端末で y/N を聞く。 */
function confirm(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE;
if (isMain) {
  // process.exit() を直接呼ぶと Node 24 (Windows) で libuv のアサーション落ちが起きるため exitCode で終了する
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`エラー: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
