# npm-license-dependencies

`package.json` の**直接依存ライブラリ**ごとに、npm レジストリ API から
「ライブラリ名 / バージョン / ライセンス / 依存ライブラリ」を取得して CSV に出力するツールです。

CycloneDX の SBOM は重複パッケージを 1 ノードにまとめるため「ライブラリごとの依存」が読み取れません。
このツールはその穴を埋めるためのもので、推移的依存の網羅は引き続き CycloneDX 側に任せる前提です。

## 機能番号 ①〜⑥

画面の設定と結果表の列見出しには同じ番号が付いています。①だけで基本の CSV が出ます（②③は①に含まれます）。④⑤⑥は任意です。

| 番号 | 機能 | 結果表の列 | 設定 / CLI |
|---|---|---|---|
| ① | 基本取得（npm レジストリ API） | ライブラリ名・バージョン・種別・ライセンス・リポジトリ | プロジェクト、出力 CSV、`--include-dev`、`--latest`、`--no-cache`、`--registry` |
| ② | 依存ライブラリ | 依存ライブラリ（package.json から求まる dependencies） | なし |
| ③ | 取得済みライブラリ | 取得済みライブラリ（package-lock.json で取得したバージョン） | なし |
| ④ | npm サイト照合 | npm サイトの dependencies、一致状態 | `--no-site`、`--site-wait`、`--site-engine`、`--browser`、`--no-site-cache` |
| ⑤ | 再帰調査 | 深さ、要求元（＋並び順） | `--recursive`、`--yes`、`--order` |
| ⑥ | 脆弱性チェック | 脆弱性、脆弱性の詳細 | `--no-vulns` |

## 動作要件

- Node.js 18 以上（組み込み `fetch` を使用）
- インターネット接続（`https://registry.npmjs.org` への HTTPS）
- npm サイト照合（任意機能）を使う場合: Microsoft Edge または Google Chrome（ヘッドレスで起動します。無ければ自動的に「サイト未取得」になります）

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
   「npm サイトの Dependencies 欄も取得して照合する」のチェックで npmjs.com との照合を ON/OFF、
   「npm サイト応答のキャッシュを使う」でサイト側のキャッシュを ON/OFF（レジストリ側とは別）、
   取得ごとの待ち時間（範囲内でランダム）、取得方法（内蔵 / Playwright）、ブラウザの実行ファイルも指定できます。
   入力内容はブラウザに記憶され、次回起動時に復元されます。
2. **実行状況** — 進捗バー、完了 / OK / NG 件数、経過時間、ログをリアルタイム表示（SSE）。
3. **結果** — テーブルで閲覧。「すべて / NG のみ / OK のみ / 不一致のみ」フィルタと名前・ライセンスの絞り込み、
   依存ライブラリ／取得済みライブラリ／npm サイトの dependencies は件数クリックで展開。「一致状態」列に 3 者の件数比較（全一致 / 不一致）を表示。
   再帰調査の結果は「並び: 親子順 / 深さ順」で切り替えられ、親子順では直接依存の直下に子・孫がインデント表示されます
   （複数の親から要求されるものは 2 回目以降「既出」として薄く表示。CSV は最初の位置に 1 行だけ）。画面先頭の「0. 動作仕様・使い方」から仕様ページを別ウィンドウで開けます。
   NG 行は行ごとの「再取得」ボタン、または「NG をすべて再取得」でレジストリから再取得できます
   （再取得はキャッシュを使いません）。実行完了時と再取得後に CSV は自動保存され、
   「CSV を保存」で別の場所へ保存し直したり、「保存先を開く」でエクスプローラーを開けます。
   「CSV を読み込む…」で、このツールが保存した CSV を結果表に復元して閲覧できます（列が少ない古い CSV も可。
   元プロジェクトの情報が無いため再取得はできません）。

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
node src/cli.js --project <対象プロジェクトのディレクトリ> [--out <出力CSV>] [--include-dev] [--latest] [--no-site] [--site-wait 1-3] [--no-cache]
```

| オプション | 説明 |
|---|---|
| `--project <dir>` | `package.json` のあるディレクトリ。既定はカレントディレクトリ |
| `--out <file>` | 出力 CSV。既定は `<project>/npm-dependencies.csv` |
| `--include-dev` | `devDependencies` も対象に含める（既定は `dependencies` のみ） |
| `--latest` | インストール済みではなく npm の最新版を参照する（npm サイトの表示と同じ） |
| `--recursive` | 依存ライブラリを再帰的にたどり、推移的依存もすべて行にする。先に再帰調査で件数を表示し、端末なら `y/N` で確認してから本調査に入る |
| `--yes` | `--recursive` の件数確認を省略して本調査に進む（バッチ用。端末でない場合は自動で進む）。中止した場合の終了コードは `3` |
| `--order <o>` | CSV の並び順。`tree`（既定。親子順＝直接依存の直下に子・孫を名前順で深さ優先。複数の親を持つ行は最初の位置に 1 回だけ）または `depth`（深さ順、同じ深さは名前順） |
| `--no-vulns` | ⑥ 脆弱性チェック（npm の advisories API、`npm audit` と同じ情報源）を行わない。「脆弱性」「脆弱性の詳細」列は空になる |
| `--no-site` | npm サイト（npmjs.com）の Dependencies 欄を取得しない。「npm サイトの dependencies」「一致状態」列は空になる |
| `--site-wait <a-b>` | npm サイト取得ごとの待ち時間の範囲（秒、範囲内でランダム）。既定 `1-3`。`--site-wait 0` で待たない |
| `--site-engine <e>` | npm サイト取得のブラウザ操作方法。`cdp`（既定、追加パッケージ不要）または `playwright`（`npm install playwright-core` が必要） |
| `--browser <path>` | npm サイト取得に使う Edge / Chrome の実行ファイル。既定は自動検出（環境変数 `NLD_BROWSER` でも指定可） |
| `--no-cache` | レジストリ応答のキャッシュ（`.cache/<name>@<version>.json`）を使わず常に再取得 |
| `--no-site-cache` | npm サイト応答のキャッシュ（`.cache/<name>@<version>.npmsite.json`）を使わず常にサイトから取得 |
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
`license` と `dependencies` を取り出します。

### npm サイト照合（任意）

既定では、さらに `https://www.npmjs.com/package/<name>/v/<version>?activeTab=dependencies` のページから
**Dependencies 欄**のライブラリ名を取得し、「依存ライブラリ」「取得済みライブラリ」との件数を照合して
「一致状態」列に **全一致 / 不一致** を出します（検証用）。

- npmjs.com は Cloudflare がブラウザ以外を 403 で拒否するため、ローカルの **Edge / Chrome をヘッドレスで 1 プロセス起動**し、
  DevTools プロトコル（`--remote-debugging-pipe`）で同じセッション内にページを順番に開いて DOM を取り出します（Playwright 等の追加パッケージ不要）。
- サイトへの連続アクセスを避けるため、取得ごとに**範囲内でランダムな待ち時間**（既定 1～3 秒）を入れ、ページは 1 つずつ順に開きます。
  Cloudflare の確認ページが出た場合は最大 45 秒待ち、通らなければ 15 秒後にもう 1 回だけ再試行します。
- 結果は `.cache/<name>@<version>.npmsite.json` にキャッシュされ、2 回目以降はサイトにアクセスしません（待ち時間も入らず、ブラウザも起動しません）。
  レジストリ応答のキャッシュとは別に、GUI「npm サイト応答のキャッシュを使う」／CLI `--no-site-cache` で無効化できます。
  ログ末尾の「サイト取得 N 回, キャッシュ M 件」で、実際にサイトへ行った回数が分かります。ブラウザのプロファイル（Cookie）はキャッシュ設定に関係なく `.cache/npmsite-browser-profile/` に保持します。
- 取得しない場合は GUI のチェックを外すか CLI で `--no-site` を指定します。取得できなかった行は「サイト未取得」になります。

#### 取得方法（エンジン）の選択

| 取得方法 | 準備 | 特徴 |
|---|---|---|
| 内蔵 `cdp`（既定） | 不要 | DevTools プロトコルを `--remote-debugging-pipe` で直接使う。依存パッケージを増やしたくない場合 |
| `playwright` | `npm install playwright-core`（1 回だけ。ブラウザのダウンロードは不要） | 標準的なブラウザ自動化ライブラリ経由。社内ルール等で「既知のライブラリを使う」ことを求められる場合。GUI の「取得方法」または CLI `--site-engine playwright` |

どちらもローカルの Edge / Chrome を 1 プロセスだけ起動し、同じ URL・User-Agent・待ち時間・キャッシュ・確認ページ再試行で動作します（サイトから見たアクセス内容は同じ）。

```powershell
npm install playwright-core
node src/cli.js --project <dir> --site-engine playwright
```

### 取得済みライブラリの引き方（Node の解決順）

「取得済みライブラリ」は、その行のライブラリの lock 上の位置を起点に
**直下（`node_modules/<行の名前>/node_modules/<名前>`）→ 祖先の直下 → トップレベル（`node_modules/<名前>`）** の順で引きます
（lockfileVersion 1/2/3 とも）。同じ名前が別バージョンでネストされている場合（例: winston だけが readable-stream 3.x を使い、
トップレベルは 1.x）も、その親が実際に使うネスト側のバージョンを返します。

### 再帰調査（任意）

GUI「再帰的にすべての依存ライブラリを抽出する」／CLI `--recursive` で、推移的依存も 1 行ずつ出力できます。

1. **再帰調査** — 直接依存を起点に「依存ライブラリ」（レジストリ上の `dependencies`）をたどり、到達したすべての
   `name@version` を列挙します（レジストリ API のみ）。子のバージョンは ① lock を Node の解決順で引く
   ② lock に無ければレジストリで範囲を満たす最大バージョン、の順で決めます。同じ `name@version` は 1 行にまとめ、
   「要求元」に親を列挙します（循環参照はここで止まります）。
2. **件数の確認** — 合計・直接・推移的・最大深さ・見込み時間を表示し、本調査を開始するか確認します
   （GUI はダイアログ、CLI は `y/N`。`--yes` で省略）。npm サイト照合ありのときは 1 行あたり「待ち時間＋数秒」かかります。
3. **本調査** — 列挙したすべての行についてライセンス・取得済みライブラリ・npm サイト照合を実行し、CSV に出力します。

```powershell
node src/cli.js --project <dir> --recursive            # 件数を見て y/N
node src/cli.js --project <dir> --recursive --yes --no-site   # 確認なし・サイト照合なし（速い）
```

たどるのは `dependencies` のみで、`devDependencies` / `peerDependencies` / `optionalDependencies` は追いません。

## CSV の列

| 列 | 内容 |
|---|---|
| ライブラリ名 | 直接依存のパッケージ名 |
| バージョン | レジストリに問い合わせた正確なバージョン |
| 依存種別 | `dependencies` / `devDependencies`。再帰調査で見つかった推移的依存は `transitive` |
| 深さ | 直接依存は `0`。推移的依存は直接依存から何段たどったか（再帰調査のときのみ 1 以上） |
| 要求元 | このライブラリを要求しているライブラリ（`name@version`、`; ` 区切り）。再帰調査のときのみ |
| ライセンス | `license`（文字列 / `{type}` / 旧形式 `licenses[]` を正規化）。無ければ `UNKNOWN`、取得できなければ `取得失敗` |
| 依存ライブラリ | npm レジストリ上のそのライブラリの `dependencies`（要求している範囲）を `name@range` で `; ` 区切り |
| 取得済みライブラリ | 「依存ライブラリ」の名前を対象プロジェクトの `package-lock.json` で引いた、実際にインストールされている `name@version`（lock が無ければ空） |
| npm サイトの dependencies | npmjs.com の該当バージョンのページの Dependencies 欄に表示される名前（Dev Dependencies は含まない）。取得しない設定では空 |
| 一致状態 | 依存ライブラリ／取得済みライブラリ／npm サイトの dependencies の 3 つの件数が同じなら `全一致`、違えば `不一致`、サイトを取得できなければ `サイト未取得`。取得しない設定では空 |
| 脆弱性 | ⑥ npm の advisories API で、そのバージョンに該当する既知の脆弱性の有無。`なし` / `あり N 件 (最高 深刻度; 内訳)` / `確認失敗`。確認しない設定では空 |
| 脆弱性の詳細 | ⑥ 各脆弱性の `GHSA-ID [深刻度 CVSS] タイトル (影響: 範囲) URL` を `; ` 区切り |
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
