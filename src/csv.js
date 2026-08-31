const BOM = '﻿';

/** RFC 4180 に従って 1 セルをエスケープする。 */
export function escapeCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * ヘッダー行 + データ行を CSV 文字列にする。
 * Excel（日本語 Windows）で文字化けしないよう UTF-8 BOM を先頭に付ける。
 * @param {string[]} header
 * @param {Array<Array<unknown>>} rows
 * @param {{ bom?: boolean }} [options]
 */
export function toCsv(header, rows, options = {}) {
  const { bom = true } = options;
  const lines = [header, ...rows].map((cells) => cells.map(escapeCell).join(','));
  return (bom ? BOM : '') + lines.join('\r\n') + '\r\n';
}

/**
 * CSV 文字列を行ごとのセル配列に戻す（RFC 4180: ダブルクォート内のカンマ・改行・"" を扱う）。
 * 先頭の BOM は無視し、改行は CRLF / LF どちらも受け付ける。末尾の空行は含めない。
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const s = text.startsWith(BOM) ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      // CRLF の CR は無視（LF で行を確定）
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}
