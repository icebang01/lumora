// 歌词自动偏移校准：纯函数解析逻辑的单元测试（无需真实音频/ffmpeg）
const test = require('node:test');
const assert = require('node:assert');
const { parseEbur128Series, parseVocalOnset } = require('../../src/main/ffmpeg/lyrics-offset');

const SAMPLE = [
  '[Parsed_ebur128_0 @ 0x1] t: 0.4s TARGET:-23 LUFS M: -60.0 S: -60.0 I: -60.0 LUFS LRA: 0.0',
  '[Parsed_ebur128_0 @ 0x1] t: 0.8s TARGET:-23 LUFS M: -55.0 S: -60.0 I: -60.0 LUFS LRA: 0.0',
  '[Parsed_ebur128_0 @ 0x1] t: 1.2s TARGET:-23 LUFS M: -50.0 S: -60.0 I: -60.0 LUFS LRA: 0.0',
  '[Parsed_ebur128_0 @ 0x1] t: 1.6s TARGET:-23 LUFS M: -48.0 S: -60.0 I: -60.0 LUFS LRA: 0.0',
  '[Parsed_ebur128_0 @ 0x1] t: 2.0s TARGET:-23 LUFS M: -20.0 S: -30.0 I: -40.0 LUFS LRA: 12.0',
  '[Parsed_ebur128_0 @ 0x1] t: 2.4s TARGET:-23 LUFS M: -18.0 S: -28.0 I: -38.0 LUFS LRA: 12.0',
  '[Parsed_ebur128_0 @ 0x1] t: 3.0s TARGET:-23 LUFS M: -15.0 S: -25.0 I: -35.0 LUFS LRA: 12.0',
].join('\n');

test('parseEbur128Series 提取 [时间, 响度] 序列并过滤窗口', () => {
  const s = parseEbur128Series(SAMPLE, 40);
  assert.strictEqual(s.length, 7);
  assert.strictEqual(s[0][0], 0.4);
  assert.strictEqual(s[4][1], -20.0);
  // 超出窗口的点被丢弃
  const s2 = parseEbur128Series(SAMPLE + '\n[Parsed_x] t: 99.0s TARGET:-23 LUFS M: -10.0 S: -20.0 I: -30.0 LUFS LRA: 5.0', 40);
  assert.strictEqual(s2.length, 7);
});

test('parseVocalOnset 返回首个明显起音（峰值 -12LU 阈值）', () => {
  // 峰值 M=-15，阈值=max(-27,-50)=-27；首个 M>=-27 在 t=2.0（M=-20）
  assert.strictEqual(parseVocalOnset(SAMPLE, 40), 2.0);
});

test('parseVocalOnset 全静音返回 null', () => {
  const silent = [
    '[Parsed_ebur128_0 @ 0x1] t: 0.4s TARGET:-23 LUFS M: -60.0 S: -60.0 I: -60.0 LUFS LRA: 0.0',
    '[Parsed_ebur128_0 @ 0x1] t: 0.8s TARGET:-23 LUFS M: -58.0 S: -60.0 I: -60.0 LUFS LRA: 0.0',
  ].join('\n');
  assert.strictEqual(parseVocalOnset(silent, 40), null);
});

test('parseVocalOnset 解析真实 ffmpeg 行格式（含 TARGET 与多空格）', () => {
  const real = '[Parsed_ebur128_0 @ 0x7f8b3c0] t: 12.4s TARGET:-23 LUFS M: -8.2 S: -20.1 I: -22.0 LUFS LRA: 9.3';
  assert.strictEqual(parseVocalOnset(real, 40), 12.4);
});
