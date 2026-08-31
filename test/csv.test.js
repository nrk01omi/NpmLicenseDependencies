import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeCell, toCsv } from '../src/csv.js';

test('カンマ・改行・ダブルクォートを含むセルはクォートする', () => {
  assert.equal(escapeCell('a,b'), '"a,b"');
  assert.equal(escapeCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCell('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCell('plain'), 'plain');
  assert.equal(escapeCell(null), '');
});

test('toCsv は BOM 付き CRLF 区切りで出力する', () => {
  const csv = toCsv(['名前', '値'], [['x', 'a,b'], ['y', 2]]);
  assert.equal(csv, '﻿名前,値\r\nx,"a,b"\r\ny,2\r\n');
});

test('toCsv は bom:false で BOM を付けない', () => {
  assert.equal(toCsv(['h'], [], { bom: false }), 'h\r\n');
});
