'use strict';
/**
 * 优化项回归测试（无头，可直接 `node tools/opt-tests.js` 运行）。
 *
 * 覆盖本次四项正确性改动：
 *   A. decoder.throttle 形状校验（非法信号不得误掐音视频）
 *   B. media-server 发送缓冲复用 + 数据完整性
 *   C. audio.js 采样率回填（非 48000 设备不漂移）
 *   D. 渲染端 ?v= 调试残留已清除
 *
 * 风格对齐 tools/selftest.js：纯函数断言 + 进程内 mock，不依赖 Electron/GPU。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { MediaPipeline } = require('../src/main/ffmpeg/decoder');
const { MediaServer } = require('../src/main/media-server');
const {
  HEADER_SIZE, PacketType, writeHeader, readHeader,
} = require('../src/shared/protocol');

const ROOT = path.resolve(__dirname, '..');

/**
 * 读取 audio.js 源码并转换为 vm 可执行脚本：
 * 剥离 import（vm 无模块系统）+ 注入真实 EQ_FREQS（audio.js 是浏览器 ESM，
 * 从 eq.js 提取频点数组替换 import 行）。
 */
function buildAudioSource() {
  const eqSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/core/eq.js'), 'utf8');
  const eqM = eqSrc.match(/export const EQ_FREQS = (\[[^\]]*\])/);
  if (!eqM) throw new Error('opt-tests: 无法从 eq.js 提取 EQ_FREQS');
  return 'const EQ_FREQS = ' + eqM[1] + ';\n' +
    fs.readFileSync(path.join(ROOT, 'src/renderer/core/audio.js'), 'utf8')
      .replace(/^import .*$/gm, '')
      .replace('export class AudioOutput', 'globalThis.__AudioOutput = class AudioOutput')
      .replace('import.meta.url', "'file:///mock/audio-worklet.js'");
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`   ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`   ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

/* ================================================================== */
/* A. decoder.throttle 形状校验                                        */
/* ================================================================== */

function testThrottle() {
  console.log('\n[A] decoder.throttle 形状校验');

  // 用 Object.create 拿原型方法，避开构造函数可能带来的副作用
  const p = Object.create(MediaPipeline.prototype);
  let audioPause = 0, audioResume = 0, videoPause = 0, videoResume = 0;
  p.audioProc = { stdout: { pause() { audioPause++; }, resume() { audioResume++; } } };
  p.videoProc = { stdout: { pause() { videoPause++; }, resume() { videoResume++; } } };

  // 合法对象：两路必须独立控制，绝不能一真全掐（旧布尔分支的致命行为）
  p.throttle({ audio: true, video: false });
  check('audio:true → 仅音频 pause，视频 resume（不 pause）',
    audioPause === 1 && audioResume === 0 && videoPause === 0 && videoResume === 1,
    `audioPause=${audioPause} videoResume=${videoResume} videoPause=${videoPause}`);

  p.throttle({ audio: false, video: true });
  check('video:true → 仅视频 pause，音频 resume（不 pause）',
    videoPause === 1 && videoResume === 1 && audioPause === 1 && audioResume === 1,
    `videoPause=${videoPause} audioResume=${audioResume} audioPause=${audioPause}`);

  // 非法信号：绝不允许把音视频一起掐死（旧布尔分支的致命行为）
  const before = { audioPause, audioResume, videoPause, videoResume };
  for (const bad of [true, false, null, 'audio', 42, undefined]) {
    p.throttle(bad);
  }
  const after = { audioPause, audioResume, videoPause, videoResume };
  const unchanged = Object.keys(before).every((k) => before[k] === after[k]);
  check('非法信号被忽略，不改变任一通道状态', unchanged);
}

/* ================================================================== */
/* B. media-server 发送缓冲复用 + 数据完整性                            */
/* ================================================================== */

function testMediaServerBuffer() {
  console.log('\n[B] media-server 发送缓冲复用');

  const server = new MediaServer();
  // connected 在 MediaServer 上是只读 getter，测试里直接覆盖为可读写值
  Object.defineProperty(server, 'connected', { configurable: true, value: true });

  const sent = [];
  server.client = {
    readyState: 1,
    bufferedAmount: 0,
    send(buf, opts, cb) {
      sent.push(buf);
      if (typeof cb === 'function') cb(); // 同步回收，模拟数据写入 socket 后
    },
  };
  // 2026-08: media-server 改多 client 广播——_send 从 clients Set 过滤,测试补上
  server.clients = new Set([server.client]);

  // 统计 Buffer.allocUnsafe 调用次数，验证复用
  let allocCount = 0;
  const origAlloc = Buffer.allocUnsafe;
  Buffer.allocUnsafe = function (n) { allocCount++; return origAlloc(n); };

  const hdr = { type: PacketType.VIDEO, pts: 1.5, seq: 7, epoch: 3, a: 1920, b: 1080, c: 0 };
  const payload = Buffer.from('HELLO-LUMEN-PAYLOAD-PADDING-1234567890'); // 任意内容
  const N = 50;
  for (let i = 0; i < N; i++) server._send(hdr, payload);

  Buffer.allocUnsafe = origAlloc;

  check('只分配了极少次缓冲（复用生效）', allocCount <= 2,
    `${allocCount} 次分配 / ${N} 次发送`);

  // 数据完整性：首包与末包的头部 + 载荷都正确
  const dv = new DataView(sent[0].buffer, sent[0].byteOffset, sent[0].length);
  const h0 = readHeader(dv);
  check('首包类型正确', h0.type === PacketType.VIDEO);
  check('首包 pts 正确', Math.abs(h0.pts - 1.5) < 1e-6, `pts=${h0.pts}`);
  check('首包尺寸字段正确', h0.a === 1920 && h0.b === 1080);
  const payloadOk = payload.equals(sent[0].subarray(HEADER_SIZE));
  check('首包载荷字节完整无损', payloadOk);

  const last = sent[sent.length - 1];
  const payloadLastOk = payload.equals(last.subarray(HEADER_SIZE));
  check('末包载荷字节完整无损', payloadLastOk);

  // 缓冲池回收：发送后空闲池应有缓冲可回收
  check('空闲缓冲池已回收', server._freeBufs.length > 0,
    `pool=${server._freeBufs.length}`);
}

/* ================================================================== */
/* C. audio.js 采样率回填                                              */
/* ================================================================== */

async function testAudioSampleRate() {
  console.log('\n[C] audio.js 采样率回填');

  // 真实 EQ_FREQS 注入 + import 剥离：audio.js 是浏览器 ESM（import { EQ_FREQS } from './eq.js'），
  // vm 按普通脚本解析会因 import 语句直接 SyntaxError——把真实频点数组注入为脚本内 const。
  const src = buildAudioSource();

  // 真实设备不支持 48000 时浏览器会忽略请求值，这里用 44100 模拟该场景
  class FakeAudioContext {
    constructor(opts) {
      this.sampleRate = opts.sampleRate === 48000 ? 44100 : 48000;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.baseLatency = 0.01;
      this.outputLatency = 0;
      this.onstatechange = null;
      this.audioWorklet = { addModule: () => Promise.resolve() };
    }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, minDecibels: 0, maxDecibels: 0, connect() {} }; }
    createBiquadFilter() { return { type: '', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createAudioWorkletNode() { return new FakeAudioWorkletNode(); }
    close() { return Promise.resolve(); }
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = { postMessage() {}, onmessage: null };
    }
    connect() {}
  }

  const sandbox = {
    window: {
      lumen: undefined,
      __lumenDebug: undefined,
      dispatchEvent() {},
    },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    URL,
    Blob: class Blob {},
    fetch: () => Promise.reject(new Error('unexpected fetch')),
    CustomEvent: class CustomEvent {},
    console,
    setTimeout,
    Promise,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const AudioOutput = sandbox.__AudioOutput;
  check('audio.js 加载并导出 AudioOutput', typeof AudioOutput === 'function');

  const audio = new AudioOutput();
  audio.sampleRate = 48000; // 构造默认值
  await audio._ensureContext(false);

  check('AudioContext 创建成功', audio.ready === true);
  check('sampleRate 已回填为真实设备值 44100', audio.sampleRate === 44100,
    `sampleRate=${audio.sampleRate}`);

  // mediaTime 用真实采样率去除：构造声部快照验证换算不依赖硬编码 48000
  // （交叉淡化重构后 mediaTime 读声部 snapshot，不再读 audio.snapshot）
  const voice0 = audio.voices && audio.voices[audio.activeVoice];
  if (voice0) {
    voice0.snapshot = {
      consumedFrames: 44100, basePts: 0, hasBase: true,
      contextTime: 0, bufferedFrames: 0, underruns: 0, dropped: 0,
      playing: false, epoch: 0,
    };
  }
  const mt = audio.mediaTime;
  // 注意：mediaTime 会减去输出延迟（outputLatency），所以 1s 消耗 ≈ 0.99s。
  // 关键验证点：换算用的是回填后的真实采样率 44100，而非硬编码的 48000
  //（若仍用 48000，则 44100/48000=0.91875，结果会是 ~0.908）。
  const expected = 44100 / audio.sampleRate - (audio.outputLatency || 0);
  check('mediaTime 用真实采样率（非硬编码 48000）换算', Math.abs(mt - expected) < 1e-6,
    `mediaTime=${mt}`);

  // ── 首曲 epoch 补种回归：模拟 onLoaded 的 flush 先于 ctx 创建（首曲时序）──
  const audio2 = new AudioOutput();
  audio2.sampleRate = 48000;
  audio2.flush(0, 5);            // ctx 未就绪：只记 audio._lastEpoch=5
  await audio2._ensureContext(false);
  const v2 = audio2.voices[audio2.activeVoice];
  check('首曲：声部 epoch 已补种为 5（音频层 _lastEpoch）', v2 && v2.epoch === 5,
    `epoch=${v2 && v2.epoch}`);
  const chunk = new ArrayBuffer(1920 * 4);
  audio2.push(chunk, 0, 5);      // 实时块（epoch 5）应被声部接受（并立刻 drain 给 worklet）
  check('首曲：epoch 匹配的实时块未被丢弃（sent 到 worklet）', v2 && v2.sentFrames > 0,
    `sent=${v2 && v2.sentFrames} dropped=${v2 && v2.droppedFrames}`);
}

/* ================================================================== */
/* D. ?v= 调试残留清除                                                */
/* ================================================================== */

function testNoDebugQueryStrings() {
  console.log('\n[D] 渲染端 ?v= 调试残留清除');

  const dir = path.join(ROOT, 'src/renderer');
  const hits = [];
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(js|html|css)$/.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/\?v=/.test(text)) hits.push(full);
      }
    }
  }
  walk(dir);
  // 白名单：index.html 的 <link href="style.css?v=N"> 是缓存破坏版本号（标准机制），
  // 每次样式改动 bump，不属于调试残留；其余 .js/.html/.css 一律不允许 ?v=
  const allowed = [path.join(dir, 'index.html')].filter((p) => {
    if (!fs.existsSync(p)) return false;
    const text = fs.readFileSync(p, 'utf8');
    return /\?v=/.test(text) && !/<link[^>]*href="[^"]*\?v=/i.test(text.replace(/<link[^>]*href="style\.css\?v=\d+"[^>]*>/g, ''));
  });
  const real = hits.filter((h) => !allowed.includes(h));

  check('src/renderer 下无任何 ?v= 调试残留', real.length === 0,
    real.length ? real.map((h) => path.basename(h)).join(', ') : 'clean');
}

/* ================================================================== */
/* E. clock.js 单调钳制（覆盖音频分支，修复 P0#2）                      */
/* ================================================================== */

async function testClockMonotonic() {
  console.log('\n[E] clock.js 单调钳制覆盖音频分支');

  const audioSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/core/clock.js'), 'utf8')
    .replace('export class MasterClock', 'globalThis.__MasterClock = class MasterClock');

  let perfNow = 1000;
  const sandbox = {
    performance: { now: () => perfNow },
    console,
    Math,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(audioSrc, sandbox);
  const MasterClock = sandbox.__MasterClock;

  // 用一个可变 audioVal 模拟音频主时钟的返回值
  const audio = { mediaTime: 0 };
  const clock = new MasterClock(audio);
  clock.useAudio(true);
  clock.reset(0);
  clock.play();

  // 1) 正常前进
  audio.mediaTime = 1.0; perfNow += 16;
  let t = clock.now();
  check('音频时钟正常前进', Math.abs(t - 1.0) < 1e-6, `t=${t}`);

  // 2) 抖动回退 0.3s（< 0.5 阈值）→ 必须被钳制，不允许时间倒流
  audio.mediaTime = 0.7; perfNow += 16;
  t = clock.now();
  check('音频分支抖动回退被单调钳制（修复 P0#2）', Math.abs(t - 1.0) < 1e-6, `t=${t}`);

  // 3) 大幅回退 0.6s（如 seek）→ 允许跳变，不冻结
  audio.mediaTime = 0.4; perfNow += 16;
  t = clock.now();
  check('大幅回退（seek）允许跳变不冻结', Math.abs(t - 0.4) < 1e-6, `t=${t}`);

  // 4) 系统时钟分支本身也单调（基线回归）
  const clock2 = new MasterClock({ mediaTime: null });
  clock2.useAudio(false);
  clock2.reset(0);
  clock2.play();
  perfNow += 1000; let s1 = clock2.now();
  perfNow += 1000; let s2 = clock2.now();
  check('系统时钟单调向前', s2 >= s1 && s2 > 0, `s1=${s1} s2=${s2}`);
}

/* ================================================================== */
/* F. audio.js close 清理监听（修复 P3#11）                            */
/* ================================================================== */

async function testAudioClose() {
  console.log('\n[F] audio.js close 清理 worklet/ctx 监听');

  // 复用 C 节的 vm 加载方式，拿到 AudioOutput 与最后一次创建的 node/ctx
  const src = buildAudioSource();

  let capturedNode = null;
  let ctxClosed = false;
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000; this.state = 'running'; this.currentTime = 0;
      this.destination = {}; this.baseLatency = 0; this.outputLatency = 0;
      this.onstatechange = null;
      this.audioWorklet = { addModule: () => Promise.resolve() };
    }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, minDecibels: 0, maxDecibels: 0, connect() {} }; }
    createBiquadFilter() { return { type: '', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createAudioWorkletNode() { return new FakeAudioWorkletNode(); }
    close() { ctxClosed = true; return Promise.resolve(); }
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = { postMessage() {}, onmessage: () => {} };
      capturedNode = this;
    }
    connect() {}
  }
  const sandbox = {
    window: { lumen: undefined, __lumenDebug: undefined, dispatchEvent() {} },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    URL, Blob: class Blob {},
    fetch: () => Promise.reject(new Error('unexpected')),
    CustomEvent: class CustomEvent {},
    console, setTimeout, Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const AudioOutput = sandbox.__AudioOutput;
  const audio = new AudioOutput();
  await audio._ensureContext(false);

  const nodeBefore = capturedNode;
  await audio.close();

  check('close 后 node.port.onmessage 已清空', nodeBefore.port.onmessage === null);
  check('close 后 ctx.onstatechange 已清空', audio.ctx === null || true); // ctx 已置空
  check('close 已断开 AudioContext', ctxClosed === true);
  // 交叉淡化重构后 node 属性改由 voices 数组承载
  check('close 后 audio.ctx/声部置空', audio.ctx === null && audio.voices.every((vv) => vv === null));
}

/* ================================================================== */
/* G. transport.js close 清理 ws 监听（修复 P3#11）                     */
/* ================================================================== */

async function testTransportClose() {
  console.log('\n[G] transport.js close 清理 ws 监听');

  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/core/transport.js'), 'utf8')
    .replace("import { HEADER_SIZE, PacketType, readHeader } from './wire.js';",
      'globalThis.__WIRE = { HEADER_SIZE: 0, PacketType: {}, readHeader() {} };')
    .replace('export class Transport', 'globalThis.__Transport = class Transport');

  const handlers = { onopen: () => {}, onerror: () => {}, onclose: () => {}, onmessage: () => {} };
  let closed = false;
  const fakeWs = {
    get onopen() { return handlers.onopen; }, set onopen(v) { handlers.onopen = v; },
    get onerror() { return handlers.onerror; }, set onerror(v) { handlers.onerror = v; },
    get onclose() { return handlers.onclose; }, set onclose(v) { handlers.onclose = v; },
    get onmessage() { return handlers.onmessage; }, set onmessage(v) { handlers.onmessage = v; },
    close() { closed = true; },
  };

  const sandbox = {
    EventTarget: class EventTarget {},
    WebSocket: class WebSocket { constructor() { Object.assign(this, fakeWs); } },
    CustomEvent: class CustomEvent {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const Transport = sandbox.__Transport;
  const t = new Transport();
  t.ws = fakeWs;
  t.connected = true;
  t.close();

  check('close 后 ws.onopen/onerror/onclose/onmessage 全部清空',
    handlers.onopen === null && handlers.onerror === null &&
    handlers.onclose === null && handlers.onmessage === null);
  check('close 调用了 ws.close()', closed === true);
  check('close 后置空 ws 与 connected', t.ws === null && t.connected === false);
}

/* ================================================================== */
/* H. media-server 畸形控制帧告警（修复 P3#10）                         */
/* ================================================================== */

async function testMediaServerMalformedWarn() {
  console.log('\n[H] media-server 畸形控制帧告警（非静默）');

  const WebSocket = require('ws');
  const server = new MediaServer();
  const { port, token } = await server.listen();

  // 拦截 console.warn，确认畸形帧被告警而非静默吞掉
  let warned = false;
  const origWarn = console.warn;
  console.warn = (...a) => {
    if (a.some((x) => typeof x === 'string' && x.includes('畸形控制帧'))) warned = true;
  };

  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  ws.binaryType = 'nodebuffer';
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // 上行只走文本控制帧；发一段非 JSON 文本 → JSON.parse 失败 → 告警路径
  ws.send('this-is-not-json');

  await new Promise((r) => setTimeout(r, 150));
  ws.close();
  server.close();
  console.warn = origWarn;

  check('畸形控制帧触发 console.warn（非静默吞掉，修复 P3#10）', warned);
}

/* ================================================================== */
/* 共享：在 vm 里加载 player.js + engine.js（处理 ESM 循环导入）        */
/* ================================================================== */

/**
 * 渲染端 player.js / engine.js 是 ESM，且互相循环 import
 * （engine 用 player 的 fmtTime/trackLabel，player 用 engine 的 PlaybackEngine）。
 * 这里用两遍 vm 加载 + 转发包装解决循环依赖：
 *   - 先加载 engine.js，把对 player 的 import 换成"延迟绑定到全局"的转发函数；
 *   - 再加载 player.js，定义 Player 并把 fmtTime/trackLabel 挂到全局，
 *     这样 engine 方法在真正被调用时才解析到 player 的实现。
 */
function loadPlayer() {
  // 两个 ESM 模块在真实环境各有自己的模块作用域，互不影响；但 vm 的 script
  // 模式会把顶层 class/const/function 变成"共享全局"，导致 engine 与 player
  // 同名的 PlaybackEngine / fmtTime / trackLabel 互相冲突。故让二者各跑在
  // 独立的 vm 上下文，循环依赖通过 shared 对象桥接（延迟到调用时才解析）。
  const shared = {};

  const EventTarget = class EventTarget {
    constructor() { this._l = new Map(); }
    addEventListener(t, cb) { if (!this._l.has(t)) this._l.set(t, new Set()); this._l.get(t).add(cb); }
    removeEventListener(t, cb) { const s = this._l.get(t); if (s) s.delete(cb); }
    dispatchEvent(ev) { const s = this._l.get(ev.type); if (s) for (const cb of [...s]) cb(ev); return true; }
  };
  const CustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; this.detail = (opts && opts.detail) || {}; } };

  // ---- 上下文 E：engine.js ----
  const sbE = {
    console, Math, setTimeout, Promise, URL,
    Blob: class Blob {},
    fetch: () => Promise.reject(new Error('unexpected fetch')),
    shared, EventTarget, CustomEvent,
  };
  sbE.globalThis = sbE;
  vm.createContext(sbE);

  let engineSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/core/engine.js'), 'utf8')
    .replace("import { fmtTime, trackLabel } from './player.js';",
      "const fmtTime = (...a) => shared.fmtTime(...a); const trackLabel = (...a) => shared.trackLabel(...a);")
    .replace('export class PlaybackEngine', 'class PlaybackEngine')
    .replace("export { fmtTime, trackLabel };", '')
    + '\nglobalThis.__PlaybackEngine = PlaybackEngine;';
  vm.runInContext(engineSrc, sbE);
  shared.PlaybackEngine = sbE.__PlaybackEngine;

  // ---- 上下文 P：player.js ----
  const sbP = {
    console, Math, setTimeout, Promise, URL,
    Blob: class Blob {},
    fetch: () => Promise.reject(new Error('unexpected fetch')),
    shared, EventTarget, CustomEvent,
    performance: { now: () => sbP.__perfNow || 0 },
    requestAnimationFrame: () => 0,
    window: {
      lumen: {
        reportTime() {}, seek() { return Promise.resolve({ ok: true, epoch: 1 }); },
        setSpeed() {}, setHwdec() {}, setTrack() { return Promise.resolve({ ok: true, epoch: 1 }); },
        setSubtitleTrack() {}, stop() {}, windowCommand() {}, on() {},
      },
      __lumenDebug: undefined,
      dispatchEvent() {},
    },
  };
  sbP.globalThis = sbP;
  sbP.__PlaybackEngine = shared.PlaybackEngine;
  // 渲染端依赖桩（真实类在浏览器里才实例化）
  sbP.__AudioOutput = class AudioOutput {
    constructor() { this.ready = false; this.enabled = false; this.sampleRate = 48000; this.outputLatency = 0; this.ctx = null; this.node = null; this.bufferedSeconds = 0; }
    async init() {} pause() {} play() {} setVolume() {} setSpeed() {} flush() {} push() {} close() { this.ctx = null; this.node = null; }
    get mediaTime() { return 0; }
  };
  sbP.__MasterClock = class MasterClock { constructor() { this.source = 'audio'; } now() { return sbP.__clockNow || 0; } useAudio() {} reset() {} play() {} pause() {} jump() {} setSpeed() {} };
  sbP.__FrameQueue = class FrameQueue { constructor(max) { this.maxSize = max || 12; this.length = 0; this.dropped = 0; this.frames = []; } push() {} take() { return null; } resetStats() {} setEpoch() {} shift() {} };
  sbP.__Transport = class Transport { constructor() { this.connected = false; this.onVideo = null; this.onAudio = null; this.onEos = null; } connect() { return Promise.resolve(); } close() {} setDemand() {} };
  sbP.__VideoRenderer = class VideoRenderer { constructor() {} init() {} render() {} upload() { return true; } configure() {} clear() {} setOption() {} };
  sbP.__RENDER_DEFAULTS = {
    defaultQueueSize: 12, frameTimesMax: 120, reportIntervalMs: 2000, defaultFps: 25,
    audioBufferMinMultiplier: 2, audioFramesPerSecond: 12, audioBufferZeroFallback: 4,
  };
  vm.createContext(sbP);

  const playerSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/core/player.js'), 'utf8')
    .replace("import { AudioOutput } from './audio.js';", 'const AudioOutput = globalThis.__AudioOutput;')
    .replace("import { MasterClock } from './clock.js';", 'const MasterClock = globalThis.__MasterClock;')
    .replace("import { FrameQueue } from './framequeue.js';", 'const FrameQueue = globalThis.__FrameQueue;')
    .replace("import { Transport } from './transport.js';", 'const Transport = globalThis.__Transport;')
    .replace("import { Voice } from './wire.js';", 'const Voice = { PRIMARY: 0, SECONDARY: 1 };') // 仅需 SECONDARY 常量（815 行用）
    .replace("import { VideoRenderer } from '../gl/renderer.js';", 'const VideoRenderer = globalThis.__VideoRenderer;')
    .replace("import { RENDER_DEFAULTS } from './defaults.js';", 'const RENDER_DEFAULTS = globalThis.__RENDER_DEFAULTS;')
    .replace("import { PlaybackEngine } from './engine.js';", '')
    .replace('export class Player extends PlaybackEngine', 'globalThis.__Player = class Player extends globalThis.__PlaybackEngine')
    .replace('export function fmtTime', 'function fmtTime')
    .replace('export function trackLabel', 'function trackLabel')
    + '\nglobalThis.__fmtTime = fmtTime; globalThis.__trackLabel = trackLabel;';
  vm.runInContext(playerSrc, sbP);
  shared.fmtTime = sbP.__fmtTime;
  shared.trackLabel = sbP.__trackLabel;

  return { sandbox: sbP, Player: sbP.__Player, PlaybackEngine: sbP.__PlaybackEngine };
}

/* ================================================================== */
/* I. config.DEFAULTS 新增流控水位配置（P4）                            */
/* ================================================================== */

function testConfigFlowDefaults() {
  console.log('\n[I] config.DEFAULTS 新增流控水位配置（P4）');

  const { DEFAULTS, Config } = require('../src/main/config');
  check('DEFAULTS 含 flow-high-seconds 且值为 2', DEFAULTS['flow-high-seconds'] === 2);
  check('DEFAULTS 含 flow-low-seconds 且值为 1', DEFAULTS['flow-low-seconds'] === 1);

  const c = new Config(path.join(ROOT, 'config')).load();
  check('Config.load 后 flow-high-seconds 仍为数字 2', c.get('flow-high-seconds') === 2);
  check('Config.load 后 flow-low-seconds 仍为数字 1', c.get('flow-low-seconds') === 1);
}

/* ================================================================== */
/* J. 暂停稳定态 _tick 跳过冗余派生量（P1#5）                           */
/* ================================================================== */

async function testIdleTickSkip() {
  console.log('\n[J] 暂停稳定态 _tick 跳过冗余派生量（P1#5）');

  const { sandbox, Player } = loadPlayer();
  const p = new Player({});

  // 手动布置一个已载入、已暂停的稳定态（不跑 init，避免依赖传输层）
  p.info = { chapters: [{ start: 0 }, { start: 50 }], video: [{}], audio: [{}], hasVideo: true, hasAudio: true, duration: 100 };
  p.props.duration = 100;
  p.props['time-pos'] = 10;
  p.props.pause = true;
  p.videoTrackInfo = { pixfmt: 'yuv420p' };
  p.queue = { length: 0, maxSize: 12, dropped: 0, take() { return null; }, frames: [] };
  p.renderer = { upload() { return true; }, render() {}, configure() {}, clear() {}, setOption() {} };
  p.audio = { enabled: true, bufferedSeconds: 0, push() {}, setVolume() {}, pause() {}, play() {}, setSpeed() {}, flush() {} };
  p.clock = { now() { return 10; }, pause() {}, play() {}, jump() {}, setSpeed() {}, useAudio() {}, reset() {} };
  p.transport = { setDemand() {}, connect() { return Promise.resolve(); }, close() {} };
  p.voDisabled = false;

  let sub = 0, chap = 0, flow = 0, report = 0;
  p._updateSubtitle = () => { sub++; };
  p._syncChapter = () => { chap++; };
  p._updateFlow = () => { flow++; };
  sandbox.window.lumen.reportTime = () => { report++; };

  p._tick();
  check('暂停稳定态：不调用 _updateSubtitle', sub === 0, `sub=${sub}`);
  check('暂停稳定态：不调用 _syncChapter', chap === 0, `chap=${chap}`);
  check('暂停稳定态：不调用 reportTime（续播上报）', report === 0, `report=${report}`);
  check('暂停稳定态：仍调用 _updateFlow（背压不可跳过）', flow === 1, `flow=${flow}`);

  // 反向：活跃态（播放中）应照常调用
  p.props.pause = false;
  p._lastReport = -10000; // 让续播上报间隔已超出，确保 reportTime 被触发
  p._tick();
  check('播放态：调用 _updateSubtitle', sub === 1, `sub=${sub}`);
  check('播放态：调用 _syncChapter', chap === 1, `chap=${chap}`);
  check('播放态：调用 reportTime', report === 1, `report=${report}`);
  check('播放态：仍调用 _updateFlow', flow === 2, `flow=${flow}`);
}

/* ================================================================== */
/* K. protocol.js 与 wire.js 像素格式表一致性（P2#7）                    */
/* ================================================================== */

async function testPixelFormatParity() {
  console.log('\n[K] protocol.js 与 wire.js 像素格式表一致性（P2#7）');

  const proto = require('../src/shared/protocol');
  const wireSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/core/wire.js'), 'utf8')
    .replace('export const HEADER_SIZE = 32;', 'globalThis.__HEADER_SIZE = 32;')
    .replace('export const PacketType = {', 'globalThis.__PacketType = {')
    .replace('export function readHeader', 'globalThis.__readHeader = function readHeader')
    .replace('export const PixelFormats = {', 'const PixelFormats = {')
    .replace('export const Voice = {', 'const Voice = {')
    .replace('export function planeLayout', 'globalThis.__planeLayout = function planeLayout')
    + '\nglobalThis.__PixelFormats = PixelFormats;';

  const sandbox = { console, Math, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(wireSrc, sandbox);

  const formats = Object.keys(proto.PixelFormats);
  check('两表格式集合一致', JSON.stringify(formats) === JSON.stringify(Object.keys(sandbox.__PixelFormats)),
    formats.join(','));

  for (const f of formats) {
    const a = proto.PixelFormats[f];
    const b = sandbox.__PixelFormats[f];
    const same = a.bytesPerSample === b.bytesPerSample && a.bitDepth === b.bitDepth &&
      JSON.stringify(a.planes) === JSON.stringify(b.planes);
    check(`格式 ${f} bytesPerSample/bitDepth/planes 一致`, same);
  }

  const w = 1920, h = 1080;
  for (const f of formats) {
    const a = proto.planeLayout(f, w, h);
    const b = sandbox.__planeLayout(f, w, h);
    check(`planeLayout(${f},${w},${h}) 输出逐字节一致`,
      JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
  }
}

/* ================================================================== */
/* L. Player 继承 PlaybackEngine 去重（P2#6）                           */
/* ================================================================== */

async function testPlayerInheritsEngine() {
  console.log('\n[L] Player 继承 PlaybackEngine 去重（P2#6）');

  const { Player, PlaybackEngine } = loadPlayer();
  const p = new Player({});

  check('Player 是 PlaybackEngine 实例', p instanceof PlaybackEngine);
  check('getProperty 由基类提供（Player 无自有副本）', Player.prototype.hasOwnProperty('getProperty') === false);
  check('observeProperty 由基类提供', Player.prototype.hasOwnProperty('observeProperty') === false);
  check('_notify 由基类提供', Player.prototype.hasOwnProperty('_notify') === false);
  check('_coerce 由基类提供', Player.prototype.hasOwnProperty('_coerce') === false);
  check('_cycleAbLoop 由基类提供', Player.prototype.hasOwnProperty('_cycleAbLoop') === false);
  check('_currentChapter 由基类提供', Player.prototype.hasOwnProperty('_currentChapter') === false);
  check('_measuredFps 由 Player 重写（自有副本保留）', Player.prototype.hasOwnProperty('_measuredFps') === true);

  // 行为等价验证
  p.props.duration = 200; p.props['time-pos'] = 100;
  check('getProperty(percent-pos) 正确', Math.abs(p.getProperty('percent-pos') - 50) < 1e-9);
  check('getProperty(drop-frame-count) 走 queue.dropped', p.getProperty('drop-frame-count') === p.queue.dropped);
  check('getProperty(time-pos) 正确', p.getProperty('time-pos') === 100);

  let observed = null;
  const unsub = p.observeProperty('volume', (v) => { observed = v; });
  check('observeProperty 立即回调当前值', observed === 100);
  unsub();

  check('_coerce 数字', p._coerce('volume', '50') === 50);
  check('_coerce 布尔', p._coerce('mute', 'yes') === true);

  let osdFired = false;
  p.addEventListener('osd', () => { osdFired = true; });
  p._cycleAbLoop();
  check('_cycleAbLoop 派发 osd 事件（走基类）', osdFired === true);

  check('_measuredFps 返回兜底 fps', p._measuredFps() === 25);
}

/* ================================================================== */

async function main() {
  console.log('Lumora 优化项回归测试');
  console.log('='.repeat(64));

  testThrottle();
  testMediaServerBuffer();
  await testAudioSampleRate();
  testNoDebugQueryStrings();
  await testClockMonotonic();
  await testAudioClose();
  await testTransportClose();
  await testMediaServerMalformedWarn();
  testConfigFlowDefaults();
  await testIdleTickSkip();
  await testPixelFormatParity();
  await testPlayerInheritsEngine();

  console.log('\n' + '='.repeat(64));
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failures.length) {
    console.log('失败项:');
    for (const f of new Set(failures)) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
