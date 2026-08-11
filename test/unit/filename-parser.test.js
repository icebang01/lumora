'use strict';
// 文件名解析器单测（characterization：按真实行为断言稳定字段；
// 已知弱点——"第13话"无空格不识别、SPY×FAMILY 标题被清洗——不锁死错误输出）。
const { test } = require('node:test');
const assert = require('node:assert');
const { parseFilename, searchQuery, guessTitle } = require('../../src/main/filename-parser');

test('制作组/季/集/分辨率全部解析', () => {
  const p = parseFilename('[SubGroup] 进击的巨人 S03E12 1080p.mkv');
  assert.equal(p.group, 'SubGroup');
  assert.equal(p.season, 3);
  assert.equal(p.episode, 12);
  assert.equal(p.resolution, '1080P');
  assert.equal(p.year, null);
  assert.equal(p.title, '进击的巨人');
});

test('年份 + 分辨率（无制作组）', () => {
  const p = parseFilename('你的名字 2016 1080p.mp4');
  assert.equal(p.year, 2016);
  assert.equal(p.resolution, '1080P');
  assert.equal(p.episode, null);
  assert.equal(p.title, '你的名字');
});

test('SPY×FAMILY 的 "- 08" 集数模式', () => {
  const p = parseFilename('[BeanSub&FZSD] SPY×FAMILY - 08 [1080p].mkv');
  assert.equal(p.group, 'BeanSub&FZSD');
  assert.equal(p.episode, 8);
  assert.equal(p.resolution, '1080P');
});

test('电影名.年份.分辨率 点分隔', () => {
  const p = parseFilename('电影.名称.2020.2160p.UHD.mkv');
  assert.equal(p.year, 2020);
  assert.equal(p.resolution, '2160P');
  assert.equal(p.title, '电影 名称');
});

test('searchQuery：withEpisode 追加第N话', () => {
  const p = parseFilename('[SubGroup] 进击的巨人 S03E12 1080p.mkv');
  assert.equal(searchQuery(p), '进击的巨人');
  assert.equal(searchQuery(p, { withEpisode: true }), '进击的巨人 第12话');
});

test('searchQuery：无集数时 withEpisode 不追加', () => {
  const p = parseFilename('你的名字 2016 1080p.mp4');
  assert.equal(searchQuery(p, { withEpisode: true }), '你的名字');
});

test('guessTitle 兜底', () => {
  assert.equal(guessTitle('你的名字 2016 1080p.mp4'), '你的名字');
  assert.equal(guessTitle('[SubGroup] 进击的巨人 S03E12 1080p.mkv'), '进击的巨人');
});

test('空输入与目录路径不崩', () => {
  const p = parseFilename('');
  assert.equal(typeof p.title, 'string');
  assert.equal(parseFilename('C:/foo/bar/').raw, 'bar');
});
