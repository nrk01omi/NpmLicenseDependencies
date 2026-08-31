import { execFile } from 'node:child_process';

/**
 * Windows のネイティブダイアログを PowerShell (System.Windows.Forms) 経由で表示する。
 * サーバーは利用者のマシン上でローカル実行される前提なので、ダイアログはそのままデスクトップに出る。
 * 戻り値: 選択されたパス。キャンセル時は null。
 */

export async function pickFolder(initialPath = '') {
  const script = `
${PS_PRELUDE}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'package.json のあるプロジェクトフォルダを選択してください'
$d.ShowNewFolderButton = $false
if ($env:NLD_INITIAL -and (Test-Path -LiteralPath $env:NLD_INITIAL)) { $d.SelectedPath = $env:NLD_INITIAL }
$r = $d.ShowDialog((New-TopMostOwner))
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`;
  return runDialog(script, { NLD_INITIAL: initialPath });
}

export async function pickSaveCsv(initialPath = '') {
  const script = `
${PS_PRELUDE}
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = '出力 CSV の保存先を指定してください'
$d.Filter = 'CSV ファイル (*.csv)|*.csv|すべてのファイル (*.*)|*.*'
$d.DefaultExt = 'csv'
$d.AddExtension = $true
$d.OverwritePrompt = $true
$d.FileName = 'npm-dependencies.csv'
if ($env:NLD_INITIAL) {
  $dir = Split-Path -Parent $env:NLD_INITIAL
  $leaf = Split-Path -Leaf $env:NLD_INITIAL
  if ($dir -and (Test-Path -LiteralPath $dir)) { $d.InitialDirectory = $dir }
  if ($leaf) { $d.FileName = $leaf }
}
$r = $d.ShowDialog((New-TopMostOwner))
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;
  return runDialog(script, { NLD_INITIAL: initialPath });
}

export async function pickOpenCsv(initialPath = '') {
  const script = `
${PS_PRELUDE}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '読み込む CSV（このツールで保存したもの）を選択してください'
$d.Filter = 'CSV ファイル (*.csv)|*.csv|すべてのファイル (*.*)|*.*'
$d.CheckFileExists = $true
if ($env:NLD_INITIAL) {
  $dir = if (Test-Path -LiteralPath $env:NLD_INITIAL -PathType Container) { $env:NLD_INITIAL } else { Split-Path -Parent $env:NLD_INITIAL }
  if ($dir -and (Test-Path -LiteralPath $dir)) { $d.InitialDirectory = $dir }
}
$r = $d.ShowDialog((New-TopMostOwner))
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;
  return runDialog(script, { NLD_INITIAL: initialPath });
}

const PS_PRELUDE = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
function New-TopMostOwner {
  # ブラウザの背面に隠れないよう、最前面の不可視フォームをオーナーにする
  $f = New-Object System.Windows.Forms.Form
  $f.TopMost = $true
  $f.ShowInTaskbar = $false
  $f.Opacity = 0
  $f.StartPosition = 'CenterScreen'
  $f.Size = New-Object System.Drawing.Size(0, 0)
  $f.Show()
  $f.Activate()
  return $f
}
`;

function runDialog(script, env) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('ネイティブダイアログは Windows でのみ利用できます。パスを直接入力してください。'));
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`ダイアログの表示に失敗しました: ${stderr?.trim() || err.message}`));
          return;
        }
        const selected = stdout.trim();
        resolve(selected === '' ? null : selected);
      },
    );
  });
}
