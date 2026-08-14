// WSOLA 离线 DSP 正确性验证（零漂移：直接抽取 audio-worklet.js 的生产函数）。
// 沙箱无音频设备，无法验证听感；本测试验证算法核心数学性质：
//   1) 变速保音高：输出频率 ≈ 输入频率（零交叉检测，±8Hz 内）
//   2) 时长缩放：  输出样本数 ≈ 输入 / speed（±6% 内）
//   3) 无 NaN / 幅度不爆（OLA 守恒，maxAbs < 1.6）
import { readFileSync } from 'node:fs';

// —— 零漂移抽取生产代码中的 wsolaSynthesize（audio-worklet.js 顶层函数）——
const src = readFileSync(new URL('../src/renderer/core/audio-worklet.js', import.meta.url), 'utf8');
// clamp 经本会话 clamp 合并后已提升为 worklet 顶级内联函数（blob 加载禁止 import，
// 故不能走 src/shared/clamp.js）。抽取 wsolaSynthesize 时必须连带 clamp 一并带入
// 作用域，否则 eval 后调用会 ReferenceError: clamp is not defined。
const mClamp = src.match(/function clamp\(value, min, max\)\s*\{[\s\S]*?\n\}/);
const mWsola = src.match(/function wsolaSynthesize\(p, output, frames, ch\)\s*\{[\s\S]*?\n\}/);
if (!mClamp) { console.error('FAIL: 未在 audio-worklet.js 找到 clamp'); process.exit(1); }
if (!mWsola) { console.error('FAIL: 未在 audio-worklet.js 找到 wsolaSynthesize'); process.exit(1); }
const wsolaSynthesize = eval('(function(){' + mClamp[0] + '\n' + mWsola[0] + '\n return wsolaSynthesize; })()');

const SR = 48000;
const W = 512, HS = 128, SEARCH = 128;

// 与生产代码一致的 M 互补(线性)窗：win[n] = (2/M)·sin²(πn/W)，Σ_{m} win[n+m*HS] ≡ 1。
function makeWin() {
  const M = W / HS;
  const win = new Float32Array(W);
  for (let n = 0; n < W; n++) {
    const s = Math.sin((Math.PI * n) / W);
    win[n] = (2 / M) * s * s;
  }
  return win;
}
function makeProcessor(channels, ringCap) {
  return {
    WSOLA_W: W, WSOLA_HS: HS, WSOLA_SEARCH: SEARCH,
    channels, sampleRate_: SR, capacity: ringCap,
    ring: new Float32Array(ringCap), readPos: 0, available: 0,
    wsolaWin: makeWin(),
    wsolaSynth: new Float32Array(W * channels),
    wsolaAna: new Float32Array(W * channels),
    wsolaDelta: null,
    speed: 1.0, gainCurrent: 1.0, gainTarget: 1.0,
  };
}

function runTest(channels, speed, freqHz) {
  const ringCap = SR * 2;
  const p = makeProcessor(channels, ringCap);
  p.speed = speed;
  const inSamples = SR; // 1 秒输入（帧数）
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < inSamples; i++) {
      p.ring[i * channels + c] = Math.sin(2 * Math.PI * freqHz * i / SR);
    }
  }
  p.readPos = 0;
  p.available = inSamples * channels; // 交错样本总数

  const out = [];
  let guard = 0;
  while (p.available > 0 && guard < 200000) {
    const obuf = [];
    for (let c = 0; c < channels; c++) obuf.push(new Float32Array(HS));
    const ok = wsolaSynthesize(p, obuf, HS, channels);
    if (!ok) break;
    for (let i = 0; i < HS; i++) out.push(obuf[0][i]); // 收集左声道
    guard++;
  }
  const outN = out.length;
  let zc = 0;
  for (let i = 1; i < outN; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) zc++;
  const estFreq = outN > 0 ? zc / 2 / (outN / SR) : 0;
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < outN; i++) {
    if (!Number.isFinite(out[i])) nan++;
    const a = Math.abs(out[i]); if (a > maxAbs) maxAbs = a;
  }
  const expectedOut = inSamples / speed; // 输出帧数（左声道）
  return { channels, speed, outN, estFreq, nan, maxAbs, expectedOut };
}

let allPass = true;
const cases = [
  [1, 1.0, 440], [1, 2.0, 440], [1, 0.5, 440],
  [2, 1.0, 440], [2, 1.5, 330], [2, 0.75, 660],
];
for (const [ch, speed, fhz] of cases) {
  const r = runTest(ch, speed, fhz);
  const freqOk = Math.abs(r.estFreq - fhz) < 8;       // 保音高
  const lenOk = Math.abs(r.outN - r.expectedOut) / r.expectedOut < 0.06; // 时长缩放
  const nanOk = r.nan === 0;
  const ampOk = r.maxAbs < 1.6;                       // 不爆音
  const pass = freqOk && lenOk && nanOk && ampOk;
  allPass = allPass && pass;
  console.log(`ch=${ch} speed=${speed} f=${fhz}Hz -> estFreq=${r.estFreq.toFixed(1)}Hz outN=${r.outN}(exp${r.expectedOut.toFixed(0)}) nan=${r.nan} maxAmp=${r.maxAbs.toFixed(3)} => ${pass ? 'PASS' : 'FAIL'}`);
}
console.log(allPass ? 'WSOLA_TEST=PASS' : 'WSOLA_TEST=FAIL');
process.exit(allPass ? 0 : 1);
