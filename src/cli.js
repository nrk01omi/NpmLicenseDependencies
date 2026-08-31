#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, rowToCells, CSV_HEADER } from './analyze.js';
import { toCsv } from './csv.js';

const THIS_FILE = fileURLToPath(import.meta.url);
export const TOOL_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
export const DEFAULT_CACHE_DIR = path.join(TOOL_ROOT, '.cache');

const USAGE = `使い方: node src/cli.js [--project <dir>] [--out <file.csv>] [--include-dev] [--no-cache]

  --project <dir>   対象プロジェクト（package.json のあるディレクトリ）。既定: カレントディレクトリ
  --out <file>      出力 CSV パス。既定: <project>/npm-dependencies.csv
  --include-dev     devDependencies も対象に含める
  --latest          インストール済みではなく npm の最新版を参照する（npm サイトの表示と同じ）
  --no-cache        レジストリ応答のキャッシュ(.cache/)を使わず常に取得する
  --registry <url>  レジストリ URL。既定: https://registry.npmjs.org
  --help            このヘルプを表示

GUI で操作したい場合は  node src/server.js  を実行してください。
`;

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string', default: '.' },
      out: { type: 'string' },
      'include-dev': { type: 'boolean', default: false },
      latest: { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      registry: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let outPath = values.out ? path.resolve(values.out) : null;
  const result = await analyze({
    projectDir: values.project,
    includeDev: values['include-dev'],
    cacheDir: values['no-cache'] ? null : DEFAULT_CACHE_DIR,
    registryUrl: values.registry,
    versionMode: values.latest ? 'latest' : 'installed',
    onStart: ({ project, deps }) => {
      outPath ??= path.join(project.root, 'npm-dependencies.csv');
      process.stderr.write(
        `対象: ${project.root}\n直接依存 ${deps.length} 件を処理します (lock: ${project.lock ? 'あり' : 'なし'}, 参照: ${values.latest ? 'npm 最新版' : 'インストール済み'})\n`,
      );
    },
  });

  await writeFile(outPath, toCsv(CSV_HEADER, result.rows.map(rowToCells)), 'utf8');

  const failed = result.rows.filter((r) => !r.ok).length;
  process.stderr.write(
    `完了: ${result.rows.length} 件 (取得失敗 ${failed} 件, レジストリ要求 ${result.stats.requests} 回, キャッシュ ${result.stats.cacheHits} 件)\n出力: ${outPath}\n`,
  );
  return failed > 0 ? 2 : 0;
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
