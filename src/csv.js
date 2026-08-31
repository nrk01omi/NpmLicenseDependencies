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
