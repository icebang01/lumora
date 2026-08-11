'use strict';
// decoder 交叉淡入淡出基础契约：voice 字段默认、startAudioOnly 前置条件与
// 无音轨分支（不真正 spawn ffmpeg，避免单测依赖外部二进制 / 临时媒体文件）。
// 完整双管线解码由 smoke 测试覆盖。
const { test } = require('node:test');
const assert = require('node:assert');
const { MediaPipeline } = require('../../src/main/ffmpeg/decoder');

test('MediaPipeline 默认 voice=0（主声部）', () => {
  const p = new MediaPipeline({});
  assert.equal(p.voice, 0, '未指定 voice 时必须为 0');
});

test('startAudioOnly 在未载入媒体时抛错', () => {
  const p = new MediaPipeline({});
  assert.throws(() => p.startAudioOnly(0, 1), /尚未载入媒体/, '未 load 应先抛错');
});

test('startAudioOnly 在无音轨信息时不 spawn（audioEnded=true）', () => {
  const p = new MediaPipeline({ ffmpegPath: 'ffmpeg' });
  p.load({ path: '/x.flac', audio: [], video: [] });
  // 无音轨：_spawnAudio 直接置 audioEnded 返回，不会拉起 ffmpeg 子进程
  p.startAudioOnly(0, 1);
  assert.equal(p.audioEnded, true, '无音轨应为已结束');
  assert.equal(p.videoEnded, true, '仅音频模式 videoEnded 必须为 true');
});

test('startAudioOnly 接受 voice 参数且不改变实例默认 voice 字段', () => {
  const p = new MediaPipeline({ ffmpegPath: 'ffmpeg' });
  p.load({ path: '/x.flac', audio: [{ codec: 'flac' }], video: [] });
  assert.equal(p.voice, 0, '实例 voice 字段默认仍为 0，副声部靠参数传递');
});
