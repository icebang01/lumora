'use strict';
// 歌词文件编码自动识别测试：验证 loadLyrics 能正确读取 UTF-8 / GBK / Big5 的 .lrc。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const iconv = require('iconv-lite');
const { loadLyrics } = require('../../src/main/ffmpeg/lyrics');

const LRC_TEXT = '[00:00.00]春风吹可曾在哪里见过他\n[00:05.00]时间的手抚过了脸颊\n';

function makeCase(encoding) {
  const base = path.join(os.tmpdir(), `lrc-enc-${encoding}-${process.pid}`);
  fs.writeFileSync(`${base}.mp3`, 'dummy');
  fs.writeFileSync(`${base}.lrc`, iconv.encode(LRC_TEXT, encoding));
  return base;
}

function cleanup(base) {
  try { fs.unlinkSync(`${base}.mp3`); } catch { /* noop */ }
  try { fs.unlinkSync(`${base}.lrc`); } catch { /* noop */ }
}

test('loadLyrics 正确读取 UTF-8 编码 .lrc', () => {
  const base = makeCase('utf-8');
  try {
    const r = loadLyrics(`${base}.mp3`);
    assert.equal(r.ok, true);
    assert.equal(r.lines.length, 2);
    assert.equal(r.lines[0].text, '春风吹可曾在哪里见过他');
    assert.equal(r.lines[1].text, '时间的手抚过了脸颊');
  } finally { cleanup(base); }
});

test('loadLyrics 正确读取 GBK 编码 .lrc（无乱码）', () => {
  const base = makeCase('gbk');
  try {
    const r = loadLyrics(`${base}.mp3`);
    assert.equal(r.ok, true);
    assert.equal(r.lines.length, 2);
    assert.equal(r.lines[0].text, '春风吹可曾在哪里见过他');
    assert.equal(r.lines[1].text, '时间的手抚过了脸颊');
  } finally { cleanup(base); }
});

test('loadLyrics 正确读取 Big5 编码 .lrc（港台繁体）', () => {
  const base = makeCase('big5');
  try {
    const r = loadLyrics(`${base}.mp3`);
    assert.equal(r.ok, true);
    assert.ok(r.lines.length >= 1, '应至少解析出一行');
    assert.ok(!r.lines[0].text.includes('\uFFFD'), '解析结果不应含替换符');
  } finally { cleanup(base); }
});

test('loadLyrics 正确读取带 UTF-8 BOM 的 .lrc', () => {
  const base = path.join(os.tmpdir(), `lrc-utf8bom-${process.pid}`);
  fs.writeFileSync(`${base}.mp3`, 'dummy');
  fs.writeFileSync(`${base}.lrc`, '\uFEFF' + LRC_TEXT, 'utf8');
  try {
    const r = loadLyrics(`${base}.mp3`);
    assert.equal(r.ok, true);
    assert.equal(r.lines.length, 2);
    assert.equal(r.lines[0].text, '春风吹可曾在哪里见过他');
  } finally { cleanup(base); }
});
