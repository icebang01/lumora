'use strict';
// 逐字歌词（word-LRC / Musixmatch rich-sync）解析测试：
// 行内 <mm:ss.xx> 时间戳应被解析为 words / charTimes，且 charTimes 长度与字数一致、单调递增。

const { test } = require('node:test');
const assert = require('node:assert');
const { parseLrc } = require('../../src/main/ffmpeg/lyrics');

test('parseLrc 识别行内 < > 逐字时间戳并产出 words/charTimes', () => {
  const text = '[00:12.00]<00:12.50>但<00:12.90>愿<00:13.30>人<00:13.70>长<00:14.10>久\n';
  const { lines } = parseLrc(text);
  assert.equal(lines.length, 1);
  const ln = lines[0];
  assert.equal(ln.text, '但愿人长久');
  assert.ok(Array.isArray(ln.words), '应有 words');
  assert.equal(ln.words.length, 5);
  assert.equal(ln.words[0].text, '但');
  assert.equal(ln.words[0].t, 12.5);
  assert.equal(ln.words[4].text, '久');
  assert.equal(ln.words[4].t, 14.1);
  // charTimes 长度 = 字数
  assert.ok(Array.isArray(ln.charTimes), '应有 charTimes');
  assert.equal(ln.charTimes.length, Array.from('但愿人长久').length);
  // charTimes 单调递增
  for (let i = 1; i < ln.charTimes.length; i++) {
    assert.ok(ln.charTimes[i] > ln.charTimes[i - 1], 'charTimes 应单调递增');
  }
});

test('parseLrc 纯文本行（无 < >）不产出 words，仅纯文本', () => {
  const text = '[00:01.00]第一段歌词\n[00:05.00]第二段歌词\n';
  const { lines } = parseLrc(text);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '第一段歌词');
  assert.equal(lines[0].words, undefined);
  assert.equal(lines[0].charTimes, undefined);
  assert.equal(lines[1].text, '第二段歌词');
});

test('parseLrc 多字词的逐字时间在词内均匀分配', () => {
  // 一个词包含 3 个字，时间区间 [10.0, 11.0) 应被均匀分配到 3 个字；
  // 「啊」从 11.0 起到下一句 12.0，单字中心落在 [11.0, 12.0)。
  const text = '[00:10.00]<00:10.00>我爱你<00:11.00>啊\n[00:12.00]下一句\n';
  const { lines } = parseLrc(text);
  const ln = lines[0];
  assert.equal(ln.words.length, 2);
  assert.equal(ln.words[0].text, '我爱你');
  assert.equal(ln.charTimes.length, 4); // 我爱你(3) + 啊(1)
  // 前 3 个字落在 [10.0, 11.0)，且递增
  assert.ok(ln.charTimes[0] >= 10.0 && ln.charTimes[2] < 11.0);
  assert.ok(ln.charTimes[0] < ln.charTimes[1] && ln.charTimes[1] < ln.charTimes[2]);
  // 第 4 个字（啊）落在 [11.0, 12.0)
  assert.ok(ln.charTimes[3] >= 11.0 && ln.charTimes[3] < 12.0);
});
