'use strict';
// AudioOutput 交叉淡入淡出状态机 + equal-power 增益斜坡（用浏览器音频 API 的
// 轻量 mock，无需真实 AudioContext / Web Audio 线程）。验证：
//   - beginCrossfade 为主/副声部安排互补的 equal-power 曲线
//   - promoteVoice 把副声部提升为主声部并回收旧槽位
//   - cancelCrossfade 丢弃副声部并恢复主声部满音量
// 真实端到端解码混音由 smoke 测试覆盖。
//
// 渲染端模块是 ESM（package.json type=commonjs，Node 按 CJS 解析 .js 会炸
// import），故复制到 .mjs 后动态导入；audio.js 依赖 eq.js，一并复制并改写导入。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// —— 浏览器音频 API 的最小 mock ——
class FakeParam {
  constructor(v = 0) { this.value = v; this.calls = []; }
  setTargetAtTime(t, time, tc) { this.value = t; this.calls.push(['setTargetAtTime', t, time, tc]); }
  cancelScheduledValues(time) { this.calls.push(['cancel', time]); }
  setValueAtTime(v, time) { this.value = v; this.calls.push(['setValueAtTime', v, time]); }
  setValueCurveAtTime(curve, time, dur) { this.value = curve[curve.length - 1]; this.calls.push(['setValueCurveAtTime', curve, time, dur]); }
  get lastCurve() { return this.calls.filter((c) => c[0] === 'setValueCurveAtTime').pop(); }
}
class FakeGain { constructor() { this.gain = new FakeParam(1); } connect() {} disconnect() {} }
class FakeAnalyser { constructor() { this.fftSize = 0; this.smoothingTimeConstant = 0; this.minDecibels = 0; this.maxDecibels = 0; } connect() {} disconnect() {} }
class FakeBiquad { constructor() { this.type = ''; this.frequency = { value: 0 }; this.Q = { value: 0 }; this.gain = new FakeParam(0); } connect() {} disconnect() {} }
class FakeWorkletNode { constructor() { this.port = { onmessage: null, postMessage() {} }; } connect() {} disconnect() {} }
class FakeAudioContext {
  constructor(opts) {
    this.state = 'running';
    this.sampleRate = (opts && opts.sampleRate) || 48000;
    this.baseLatency = 0.01;
    this.outputLatency = 0.02;
    this.destination = {};
    this.onstatechange = null;
    this._t = 0;
    this.audioWorklet = { addModule: async () => {} };
  }
  get currentTime() { return this._t; }
  set currentTime(v) { this._t = v; }
  createGain() { return new FakeGain(); }
  createAnalyser() { return new FakeAnalyser(); }
  createBiquadFilter() { return new FakeBiquad(); }
  createAudioWorkletNode() { return new FakeWorkletNode(); }
  async close() {}
}

global.window = { lumen: { getAudioWorkletSource: () => null }, dispatchEvent() {} };
global.AudioContext = FakeAudioContext;
global.AudioWorkletNode = FakeWorkletNode;

let AudioOutput;
const tmpFiles = [];
before(async () => {
  const pid = process.pid;
  const eqMjs = path.join(os.tmpdir(), `eq-${pid}.mjs`);
  const audioMjs = path.join(os.tmpdir(), `audio-${pid}.mjs`);
  fs.copyFileSync(path.join(__dirname, '../../src/renderer/core/eq.js'), eqMjs);
  let src = fs.readFileSync(path.join(__dirname, '../../src/renderer/core/audio.js'), 'utf8');
  src = src.replace("./eq.js", `./eq-${pid}.mjs`);
  fs.writeFileSync(audioMjs, src);
  tmpFiles.push(eqMjs, audioMjs);
  // 注意：临时文件延后到 after 再删——Windows 上 import 后仍可能持有文件句柄，
  // 在 before 内立即删除会让后续测试访问模块资源失败（表现为 ready 异常）。
  ({ AudioOutput } = await import(pathToFileURL(audioMjs).href));
});

after(async () => {
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
});

test('beginCrossfade 安排互补 equal-power 曲线（主→0 / 副→1）', async () => {
  const ao = new AudioOutput();
  await ao._ensureContext();
  await ao.ensureSecondary();
  const a = ao.voices[0], b = ao.voices[1];
  ao.beginCrossfade(2.0, true);

  const aCurve = a.gain.gain.lastCurve;
  const bCurve = b.gain.gain.lastCurve;
  assert.ok(aCurve, '主声部应有曲线');
  assert.ok(bCurve, '副声部应有曲线');
  assert.ok(Math.abs(aCurve[1][0] - 1) < 1e-6, '主声部起点≈1');
  assert.ok(Math.abs(aCurve[1][aCurve[1].length - 1] - 0) < 1e-6, '主声部终点=0');
  assert.ok(Math.abs(bCurve[1][0] - 0) < 1e-6, '副声部起点=0');
  assert.ok(Math.abs(bCurve[1][bCurve[1].length - 1] - 1) < 1e-6, '副声部终点=1');
  const mid = bCurve[1][Math.floor(bCurve[1].length / 2)];
  assert.ok(Math.abs(mid - 0.7071) < 0.05, 'equal-power 中点≈0.707，实际=' + mid);
  // 互补性：两声部在相同索引处 a²+b²≈1（总能量恒定，无听感凹陷）
  for (let i = 0; i < aCurve[1].length; i++) {
    const e = aCurve[1][i] * aCurve[1][i] + bCurve[1][i] * bCurve[1][i];
    assert.ok(Math.abs(e - 1) < 1e-5, `索引${i}处 a²+b²应≈1，实际=${e}`);
  }
});

test('beginCrossfade 线性模式为直线斜坡', async () => {
  const ao = new AudioOutput();
  await ao._ensureContext();
  await ao.ensureSecondary();
  ao.beginCrossfade(2.0, false);
  const bCurve = ao.voices[1].gain.gain.lastCurve;
  const c = bCurve[1];
  assert.ok(Math.abs(c[0] - 0) < 1e-6, '线性起点=0');
  assert.ok(Math.abs(c[c.length - 1] - 1) < 1e-6, '线性终点=1');
  // 离散采样下中点非精确 0.5（i/(pts-1)），改为校验每步增量≈1/(pts-1)
  const step = 1 / (c.length - 1);
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    assert.ok(Math.abs(d - step) < 1e-3, `第${i}步增量应≈${step}，实际=${d}`);
  }
});

test('promoteVoice 提升副声部为主声部并回收旧槽位', async () => {
  const ao = new AudioOutput();
  await ao._ensureContext();
  await ao.ensureSecondary();
  ao.beginCrossfade(2.0, true);
  ao.promoteVoice();
  assert.equal(ao.activeVoice, 1, 'activeVoice 应切到槽位 1');
  assert.equal(ao.voices[0], null, '旧主声部槽位应被释放回收');
  assert.ok(ao.voices[1], '新主声部槽位仍在');
  assert.equal(ao.voices[1].gain.gain.value, 1, '新主声部系数应复位为 1');
});

test('cancelCrossfade 丢弃副声部并恢复主声部满音量', async () => {
  const ao = new AudioOutput();
  await ao._ensureContext();
  await ao.ensureSecondary();
  ao.beginCrossfade(2.0, false);
  ao.cancelCrossfade();
  assert.equal(ao.voices[1], null, '副声部应被丢弃');
  assert.equal(ao.activeVoice, 0, 'activeVoice 仍为主声部');
  const aCurve = ao.voices[0].gain.gain.lastCurve;
  assert.ok(aCurve, '主声部应有回满曲线');
  assert.ok(Math.abs(aCurve[1][aCurve[1].length - 1] - 1) < 1e-6, '主声部终点应恢复为 1');
});

test('promoteVoice 后 pushVoice 继续喂新主声部槽位', async () => {
  const ao = new AudioOutput();
  await ao._ensureContext();
  await ao.ensureSecondary();
  ao.beginCrossfade(2.0, true);
  ao.promoteVoice();
  ao.pushVoice(1, new ArrayBuffer(2048 * 2 * 4), 0, 0);
  const v1 = ao.voices[1];
  // 注意：mock 的 worklet 上报零缓冲，_drain 会立即把 pending 下发到 sentFrames，
  // 所以用 sentFrames 验证"提升后的新主声部槽位仍接收 PCM"（epoch/ready 不符会被拒）。
  assert.ok(v1.sentFrames >= 2048, '提升后的新主声部应继续接收 PCM，sentFrames=' + v1.sentFrames);
});
