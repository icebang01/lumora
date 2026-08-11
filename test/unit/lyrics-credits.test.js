'use strict';
// parseLrc credits 提取测试：标准标签解析 + 时间轴 credits 行提取并保留在滚动歌词 + 同义词归一化。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { parseLrc, loadLyrics } = require('../../src/main/ffmpeg/lyrics');

test('parseLrc 解析标准标签 [ti:]/[ar:]/[al:]/[au:]/[music:]', () => {
  const text = '[ti:借口]\n[ar:周杰伦]\n[al:范特西]\n[au:周杰伦]\n[music:周杰伦]\n[00:01.00]第一段歌词\n';
  const { lines, meta } = parseLrc(text);
  assert.equal(meta.tags.ti, '借口');
  assert.equal(meta.tags.ar, '周杰伦');
  assert.equal(meta.tags.al, '范特西');
  assert.equal(meta.tags.au, '周杰伦');
  assert.equal(meta.tags.music, '周杰伦');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '第一段歌词');
});

test('parseLrc 把时间轴 credits 行提取到 meta.credits，同时保留在滚动歌词中', () => {
  const text = '[00:00.00]借口 - 周杰伦\n[00:00.50]词：周杰伦\n[00:01.00]曲：周杰伦\n[00:01.50]编曲：周杰伦\n[00:02.00]第一段歌词\n';
  const { lines, meta } = parseLrc(text);
  // 标题行 + 3 个 credits 行 + 第一段歌词，全部保留在滚动歌词
  assert.equal(lines.length, 5);
  assert.equal(lines[0].text, '借口 - 周杰伦');
  assert.equal(lines[1].text, '词：周杰伦');
  assert.equal(lines[2].text, '曲：周杰伦');
  assert.equal(lines[3].text, '编曲：周杰伦');
  assert.equal(lines[4].text, '第一段歌词');
  assert.equal(meta.credits['词'], '周杰伦');
  assert.equal(meta.credits['曲'], '周杰伦');
  assert.equal(meta.credits['编曲'], '周杰伦');
});

test('parseLrc 归一化同义 credits 关键词（作词→词、作曲→曲、编配→编曲）', () => {
  const text = '[00:00.50]作词：方文山\n[00:01.00]作曲：周杰伦\n[00:01.50]编配：林迈可\n[00:02.00]歌词\n';
  const { meta } = parseLrc(text);
  assert.equal(meta.credits['词'], '方文山');
  assert.equal(meta.credits['曲'], '周杰伦');
  assert.equal(meta.credits['编曲'], '林迈可');
});

test('loadLyrics 返回 meta（含 tags 与 credits）', () => {
  const base = path.join(os.tmpdir(), `lrc-credits-${process.pid}`);
  fs.writeFileSync(`${base}.mp3`, 'dummy');
  fs.writeFileSync(`${base}.lrc`, '[ti:借口]\n[00:00.50]词：周杰伦\n[00:01.00]第一段歌词\n', 'utf8');
  try {
    const r = loadLyrics(`${base}.mp3`);
    assert.equal(r.ok, true);
    assert.ok(r.meta, '应返回 meta');
    assert.equal(r.meta.tags.ti, '借口');
    assert.equal(r.meta.credits['词'], '周杰伦');
  } finally {
    try { fs.unlinkSync(`${base}.mp3`); } catch { /* noop */ }
    try { fs.unlinkSync(`${base}.lrc`); } catch { /* noop */ }
  }
});

test('parseLrc 不会误伤普通歌词（「他说：你回来」不在白名单→保留为歌词；「作曲：周杰伦」保留并提取 credits）', () => {
  const text = '[00:05.00]他说：你回来\n[00:10.00]作曲：周杰伦\n';
  const { lines, meta } = parseLrc(text);
  assert.equal(lines.length, 2, '普通含冒号歌词保留，credits 行也保留在滚动歌词');
  assert.equal(lines[0].text, '他说：你回来');
  assert.equal(lines[1].text, '作曲：周杰伦');
  assert.equal(meta.credits['曲'], '周杰伦');
});
