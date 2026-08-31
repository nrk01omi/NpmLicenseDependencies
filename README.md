# npm-license-dependencies

`package.json` の**直接依存ライブラリ**ごとに、npm レジストリ API から
「ライブラリ名 / バージョン / ライセンス / 依存ライブラリ」を取得して CSV に出力するツールです。

CycloneDX の SBOM は重複パッケージを 1 ノードにまとめるため「ライブラリごとの依存」が読み取れません。
このツールはその穴を埋めるためのもので、推移的依存の網羅は引き続き CycloneDX 側に任せる前提です。

## 動作要件

- Node.js 18 以上（組み込み `fetch` を使用）
- インターネット接続（`https://registry.npmjs.org` への HTTPS）

## セットアップ

```powershell
cd c:\Apps\NpmLicenseDependencies
npm install
```

## 使い方（GUI）

```powershell
npm start          # = node src/server.js  → ブラウザで http://localhost:3939/ が開きます
```

ブラウザ画面で次の操作ができます。

1. **設定** — プロジェクトフォルダと出力 CSV を「参照…」ボタン（Windows のフォルダ選択 / 保存ダイアログ）
   または直接入力で指定。devDependencies を含めるか、キャッシュを使うか、レジストリ URL も指定できます。
   入力内容はブラウザに記憶され、次回起動時に復元されます。
2. **実行状況** — 進捗バー、完了 / OK / NG 件数、経過時間、ログをリアルタイム表示（SSE）。
3. **結果** — テーブルで閲覧。「すべて / NG のみ / OK のみ」フィルタと名前・ライセンスの絞り込み、
   依存ライブラリ／取得済みライブラリは件数クリックで展開。画面先頭の「0. 動作仕様・使い方」から仕様ページを別ウィンドウで開けます。
   NG 行は行ごとの「再取得」ボタン、または「NG をすべて再取得」でレジストリから再取得できます
   （再取得はキャッシュを使いません）。実行完了時と再取得後に CSV は自動保存され、
   「CSV を保存」で別の場所へ保存し直したり、「保存先を開く」でエクスプローラーを開けます。

**取得エラー時の動作**は設定で選べます（既定: 確認ダイアログを表示）。

| 設定 | 動作 |
|---|---|
| 確認ダイアログを表示する | 失敗するたびにダイアログを出し、次の 4 つから選びます。並列で複数失敗しても 1 件ずつ順番に確認します |
| 確認せず自動でリトライする | 「自動リトライ回数」まで待ち時間を置いてリトライし、それでも失敗したら NG のまま次へ |
| 確認せず失敗のまま次へ進む | NG のまま続行（従来の CLI と同じ） |

ダイアログの選択肢:

- **1 回リトライ** — その 1 件だけもう一度取得。失敗したら再度確認
- **以降は確認せず自動でリトライ** — この件と以降の失敗は、自動リトライ回数まで確認なしでリトライ
- **失敗のまま次へ進む** — その 1 件は NG のまま続行。次の失敗ではまた確認
- **以降の失敗もすべて無視して続行** — 以降は確認せず NG のまま進める（完了後に「再取得」でまとめてやり直せます）

サーバーは `127.0.0.1` にのみバインドされ、LAN からはアクセスできません。ポートは `--port <番号>`、
ブラウザを自動で開きたくない場合は `--no-open` を付けます。

## 使い方（CLI）

```powershell
node src/cli.js --project <対象プロジェクトのディレクトリ> [--out <出力CSV>] [--include-dev] [--no-cache]
```

| オプション | 説明 |
|---|---|
| `--project <dir>` | `package.json` のあるディレクトリ。既定はカレントディレクトリ |
| `--out <file>` | 出力 CSV。既定は `<project>/npm-dependencies.csv` |
| `--include-dev` | `devDependencies` も対象に含める（既定は `dependencies` のみ） |
| `--latest` | インストール済みではなく npm の最新版を参照する（npm サイトの表示と同じ） |
| `--no-cache` | レジストリ応答のキャッシュ（このツール直下の `.cache/`）を使わず常に再取得 |
| `--registry <url>` | レジストリ URL（社内ミラー等）。既定 `https://registry.npmjs.org` |

例:

```powershell
node src/cli.js --project c:\Apps\monitor\OllamaProxy --out c:\work\ollamaproxy-deps.csv
```

終了コード: `0` = 全件成功、`2` = 取得失敗した行がある（CSV は出力済み）、`1` = 実行エラー。

## 入力と問い合わせバージョンの決め方

入力は対象プロジェクトの `package.json`（必須）、`package-lock.json`、`node_modules`（いずれも任意）です。

### 参照バージョン（インストール済み / npm の最新版）

依存ライブラリやライセンスは**バージョンごとに変わります**。例えば `axios` は 1.16.1 で `https-proxy-agent` が
依存に加わったため、1.14.0 なら 3 件、最新版なら 4 件になります。npm サイトのパッケージページは既定で
**最新版**を表示しているので、インストール済みのバージョンと食い違うことがあります
（サイト側でも `https://www.npmjs.com/package/axios/v/1.14.0` のようにバージョンを指定すれば一致します）。

| 設定 | 参照するバージョン | 用途 |
|---|---|---|
| インストール済み（既定） | `package-lock.json` / `node_modules` のバージョン | 実際に配布・実行しているものの監査。CycloneDX の結果と突き合わせる場合はこちら |
| npm の最新版（GUI の「参照バージョン」／CLI の `--latest`） | `dist-tags.latest` | npm サイトの表示と同じ内容を得たい場合。インストール済みと違うときは備考欄にその旨を記載 |

### インストール済みモードでのバージョン決定

レジストリに問い合わせる**正確なバージョン**は次の優先順位で決めます。

1. `package-lock.json` の `packages["node_modules/<name>"].version`（lockfileVersion 2/3）／`dependencies[<name>].version`（v1）
2. `node_modules/<name>/package.json` の `version`
3. レジストリの packument から `semver.maxSatisfying(全バージョン, range)`（備考欄に記載）
4. それでも決まらなければ `dist-tags.latest`（備考欄に「範囲未解決」と記載）

決まったバージョンで `GET https://registry.npmjs.org/<name>/<version>` を呼び、その応答（package.json 相当）から
`license` と `dependencies` を取り出します。npmjs.com の HTML はスクレイピングしません。

## CSV の列

| 列 | 内容 |
|---|---|
| ライブラリ名 | 直接依存のパッケージ名 |
| バージョン | レジストリに問い合わせた正確なバージョン |
| 依存種別 | `dependencies` / `devDependencies` |
| ライセンス | `license`（文字列 / `{type}` / 旧形式 `licenses[]` を正規化）。無ければ `UNKNOWN`、取得できなければ `取得失敗` |
| 依存ライブラリ | npm レジストリ上のそのライブラリの `dependencies`（要求している範囲）を `name@range` で `; ` 区切り |
| 取得済みライブラリ | 「依存ライブラリ」の名前を対象プロジェクトの `package-lock.json` で引いた、実際にインストールされている `name@version`（lock が無ければ空） |
| リポジトリ | `repository.url`（無ければ `homepage`） |
| 備考 | 取得失敗の理由、範囲解決の方法、lock で解決できなかった依存など |

CSV は UTF-8 **BOM 付き**・CRLF なので、Excel でダブルクリックしてもヘッダーが文字化けしません。

## CycloneDX 出力との結合

- このツールの「取得済みライブラリ」列は `name@version` 形式なので、CycloneDX の `components[].name` / `version`
  （または purl `pkg:npm/<name>@<version>`）と突き合わせできます。
- 直接依存（本ツール）→ 推移的依存（CycloneDX）の順に結合すると、「どの直接依存が何を引き込んでいるか」を
  1 段目まで正確に示したうえで、全体の網羅は SBOM 側に委ねる構成になります。

## 対象外・注意点

- `git+https://...`、`file:`、`github:user/repo` などレジストリ以外の依存指定は、lock / node_modules にバージョンが無い場合
  「取得失敗」になります（行は残ります）。
- `peerDependencies` / `optionalDependencies` は「依存ライブラリ」列に含めません。
- レジストリの 429 / 5xx は指数バックオフで 3 回までリトライします。同時実行は 5 並列です。

## テスト

```powershell
npm test
```
