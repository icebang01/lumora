'use strict';
// Player 级交叉淡入淡出编排集成测试。
//
// 目标：不依赖真实 WebGL / WebSocket，直接装载真正的 Player 类，驱动其
// 交叉淡入淡出编排状态机，验证「编排层 → 音频层」全链路在 player.js 这一级
// 的行为：
//   1. startCrossfade 幂等 + 代际标记 + 调 window.lumen.crossfadeStart
//   2. 主进程 echo player:crossfade-started → _onCrossfadeStarted 建副声部槽位
//   3. _tickCrossfade 临近曲尾起 equal-power 斜坡
//   4. ctx 时间到点 → commitCrossfade 提升副声部、推进 epoch、发 crossfade-committed
//   5. 代际守卫：过期 reqId 的 started 事件被丢弃，杜绝双音
//   6. 取消：_cancelCrossfade 释放副声部并通知主进程
//
// 装载方式：把 player.js 复制到临时 .mjs，改写导入——
//   - './audio.js' → 临时 audio.mjs（其内部 './eq.js' 也改写为临时 eq.mjs）
//   - '../gl/renderer.js' → 内联 stub（构造函数仅置字段，无需 WebGL）
//   - 其余 core/ 依赖走真实模块的绝对路径导入（其传递依赖自然从源码目录解析）
// 浏览器音频 API 用轻量 mock，无需真实 AudioContext / Web Audio 线程。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

/* —— 浏览器音频 API 最小 mock（同 audio-crossfade.test.js） —— */
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

const coreDir = path.join(__dirname, '../../src/renderer/core');
const tmpFiles = [];
let Player;

before(async () => {
  // core/ 这些模块彼此仅内部相对引用，且无 ../shared 之类的外部依赖；
  // 连同 player 一起复制到 tmp 并改为 .mjs，把相对导入改写到临时副本，
  // 即可在 Node（package type=commonjs，.js 被当 CJS）下以 ESM 装载。
  const pid = process.pid;
  const bases = ['player', 'engine', 'audio', 'clock', 'framequeue', 'transport', 'wire', 'defaults', 'eq'];
  const map = {};
  for (const b of bases) map[b] = path.join(os.tmpdir(), `cf-${b}-${pid}.mjs`);

  const rewrite = (src) => {
    // 改写 core/ 内部相对导入 ./X.js → 临时 cf-X-<pid>.mjs
    src = src.replace(/from\s+'\.\/([a-zA-Z0-9_-]+)\.js'/g, (m, base) =>
      (map[base] ? `from './cf-${base}-${pid}.mjs'` : m));
    // 用内联 stub 替换 VideoRenderer（构造函数仅置字段，无需 WebGL）
    src = src.replace(
      "import { VideoRenderer } from '../gl/renderer.js';",
      "class VideoRenderer { constructor(c){ this.canvas = c; } init(){ this.voDisabled = true; } render(){} setOption(){} dispose(){} }"
    );
    return src;
  };

  for (const b of bases) {
    const s = rewrite(fs.readFileSync(path.join(coreDir, `${b}.js`), 'utf8'));
    fs.writeFileSync(map[b], s);
    tmpFiles.push(map[b]);
  }

  ({ Player } = await import(pathToFileURL(map.player).href));
});

after(async () => {
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
});

/** 构造并初始化一个可直接驱动交叉淡入淡出的 Player（跳过 init 的网络/WebGL 部分）。 */
async function makePlayer() {
  const p = new Player({});
  await p.audio._ensureContext();           // 建立 FakeAudioContext，ready=true
  p.epoch = 0;
  p.info = { path: 'A.mp3' };
  p.props.duration = 100;
  p.props['time-pos'] = 0;
  p.props.pause = false;
  p.props.hasAudio = true;
  p.props.path = 'A.mp3';
  return p;
}

test('startCrossfade 调用 crossfadeStart 并写入代际标记；同曲幂等跳过', async () => {
  const p = await makePlayer();
  let captured = null;
  global.window.lumen.crossfadeStart = async (info, reqId) => { captured = { info, reqId }; return { ok: true }; };

  p.startCrossfade({ path: 'B.mp3' }, 2.0);
  assert.equal(p._crossfadePending, true, '应进入 pending');
  assert.ok(captured, '应调用 window.lumen.crossfadeStart');
  assert.equal(captured.reqId, p._crossfadeReqId, '传出 reqId 应与内部代际标记一致');
  assert.equal(p._crossfadeDuration, 2.0);

  // 同曲重复调用应幂等跳过（不新增代际、不重复请求）
  const reqBefore = p._crossfadeReqId;
  p.startCrossfade({ path: 'B.mp3' }, 2.0);
  assert.equal(p._crossfadeReqId, reqBefore, '同曲重复 startCrossfade 不应自增代际');
});

test('编排全链路：started → 起斜坡 → 到点提升副声部并发 crossfade-committed', async () => {
  const p = await makePlayer();
  let committed = null;
  p.addEventListener('crossfade-committed', (e) => { committed = e.detail; });
  global.window.lumen.crossfadeStart = async () => ({ ok: true });

  p.startCrossfade({ path: 'B.mp3' }, 2.0);
  const reqId = p._crossfadeReqId;

  // 主进程 echo：副声部就绪（epoch=7）
  await p._onCrossfadeStarted({ epoch: 7, info: { path: 'B.mp3', title: 'B', duration: 200, hasAudio: true }, reqId });
  assert.equal(p._secondaryEpoch, 7, '副声部 epoch 应记入');
  assert.ok(p.audio.voices[1], '应建立副声部槽位');
  assert.equal(p.audio.activeVoice, 0, '提升前 activeVoice 仍为主声部');

  // 临近曲尾（100 - 2 - 0.05 = 97.95）：_tick 应起斜坡
  p.props['time-pos'] = 98;
  p._tickCrossfade();
  assert.equal(p._crossfadeRamping, true, '应进入斜坡');
  assert.equal(p._crossfadePending, false);
  assert.equal(p.audio.activeVoice, 0, '斜坡中尚未提升');

  // ctx 时间越过 promoteAt：_tick 应提交
  p.audio.ctx.currentTime = p._crossfadePromoteAt + 0.01;
  p._tickCrossfade();

  assert.ok(committed, '应派发 crossfade-committed');
  assert.equal(p.epoch, 7, '主 epoch 应切换到副声部 epoch');
  assert.equal(p._secondaryEpoch, null, '副声部 epoch 应已转正清零');
  assert.equal(p.audio.activeVoice, 1, 'activeVoice 应提升到槽位 1');
  assert.equal(p.audio.voices[0], null, '旧主声部槽位应被回收');
  assert.equal(p._crossfadeRamping, false);
  assert.equal(p.props.duration, 200, 'player.duration 应更新为新曲');
});

test('代际守卫：过期 reqId 的 started 事件被丢弃，不建副声部', async () => {
  const p = await makePlayer();
  global.window.lumen.crossfadeStart = async () => ({ ok: true });

  p.startCrossfade({ path: 'B.mp3' }, 2.0);
  const staleReq = p._crossfadeReqId;
  // 模拟被新的交叉淡入淡出替代（代际自增）
  p.startCrossfade({ path: 'C.mp3' }, 2.0);
  assert.notEqual(p._crossfadeReqId, staleReq, '新发起应自增代际');

  // 旧 B 的 started 带着过期 reqId 到达 → 必须被忽略
  await p._onCrossfadeStarted({ epoch: 7, info: { path: 'B.mp3' }, reqId: staleReq });
  assert.equal(p._secondaryEpoch, null, '过期副声部不应建立');
  assert.equal(p.audio.voices[1], null, '不应出现副声部槽位');
});

test('取消：_cancelCrossfade 释放副声部并通知主进程 endCrossfade', async () => {
  const p = await makePlayer();
  let cancelled = false;
  global.window.lumen.crossfadeStart = async () => ({ ok: true });
  global.window.lumen.crossfadeCancel = async () => { cancelled = true; };

  p.startCrossfade({ path: 'B.mp3' }, 2.0);
  const reqId = p._crossfadeReqId;
  await p._onCrossfadeStarted({ epoch: 7, info: { path: 'B.mp3' }, reqId });
  assert.ok(p.audio.voices[1], '取消前应存在副声部');

  p._cancelCrossfade();
  assert.equal(p.audio.voices[1], null, '副声部应被释放');
  assert.equal(p._secondaryEpoch, null);
  assert.equal(p._crossfadePending, false);
  assert.equal(p._crossfadeRamping, false);
  assert.equal(cancelled, true, '应通知主进程取消副声部');
});

test('未就绪副声部遇主声部 EOF：_onEos 放过 EOF 退化为普通切轨（防无声卡死）', async () => {
  const p = await makePlayer();
  global.window.lumen.crossfadeStart = async () => ({ ok: true });

  // 仅请求、副声部尚未就绪（_secondaryEpoch 仍 null）
  p.startCrossfade({ path: 'B.mp3' }, 2.0);
  assert.equal(p._secondaryEpoch, null, '副声部未就绪');

  let eofFired = false;
  p.addEventListener('eof', () => { eofFired = true; });
  p._onEos({ epoch: p.epoch, voice: 0 });
  assert.equal(eofFired, true, '副声部未就绪时应放过主声部 EOF，退化为普通切轨');
});
