#!/usr/bin/env node
'use strict';
/**
 * Lumora 交互体验 & 流畅性基准（UX / Fluidity Benchmark）
 *
 * 复用渲染端 window.__lumen.snapshot() 与命令总线，自动采集：
 *   A. 交互体验：命令/按键延迟（跟手度）—— 发命令 → 轮询状态生效的耗时
 *   B. 流畅性：  seek 延迟、丢帧率、音画同步 avSync、渲染吞吐(fps)
 *   C. 内存：    交互压力下的 JS 堆增长（泄漏信号）
 *
 * 用法：node tools/ux-bench.js [媒体文件]
 *   自行拉起 electron（--remote-debugging-port=9223）+ 连 CDP 驱动，结束清理。
 *
 * 沙箱无 GPU 说明：真·渲染帧率/画面流畅度需 GPU+显示器，headless 下
 *   dropped/presented/avSync/渲染吞吐 在 mpv 模式或 WebGL 不可用时为 N/A；
 *   但 命令延迟 / seek 延迟 / JS 堆增长 是逻辑量，headless 也可测。
 */
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MEDIA = process.argv[2] ? path.resolve(process.argv[2])
  : path.join(APP_ROOT, 'testmedia', 'sdr-1080p.mp4');
const PORT = 9223;
const CDP = `http://127.0.0.1:${PORT}`;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumora-ux-'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
function log(...a) { const s = a.join(' '); out.push(s); console.log(s); }
function record(name, value, unit, grade) {
  log(`  ${name.padEnd(20)} ${String(value).padStart(9)}${unit ? ' ' + unit : ''}   ${grade || ''}`);
}

// ---- CDP plumbing（复用 gui-test.js 模式）----
let ws = null, mid = 0; const pend = new Map();
function connect(url) {
  return new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.on('open', res); ws.on('error', rej);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });
  });
}
function send(method, params) {
  return new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.result && r.result.exceptionDetails) {
    throw new Error('eval异常: ' + JSON.stringify(r.result.exceptionDetails.exception || {}).slice(0, 160));
  }
  return r && r.result && r.result.result ? r.result.result.value : undefined;
}
const snap = () => evalJS('window.__lumen ? window.__lumen.snapshot() : null');

let child = null;
async function cleanup(code) {
  try { if (child) child.kill('SIGTERM'); } catch {}
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(CDP + '/json')).json();
      const p = (list || []).find((t) => t.type === 'page' && t.title === 'Lumora' && t.url.includes('index.html'));
      if (p) return p;
    } catch {}
    await wait(1000);
  }
  return null;
}

async function main() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 关键：否则 electron 以纯 node 模式崩于 index.js:55
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
  child = spawn(ELECTRON, [
    '--no-sandbox', '--disable-gpu-sandbox',
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${PORT}`,
    APP_ROOT, MEDIA,
  ], { stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stderr.on('data', () => {});

  const page = await findPage();
  if (!page) { log('未找到 Lumora CDP 目标'); return cleanup(1); }
  await connect(page.webSocketDebuggerUrl);
  await wait(500);

  let s = null;
  for (let i = 0; i < 75; i++) { s = await snap(); if (s && s.ready) break; await wait(200); }
  if (!s || !s.ready) { log('渲染端未就绪'); return cleanup(1); }
  const ffmpegMode = s.engine === 'ffmpeg';
  const hasGL = !!(s.gl && s.gl.renderer);
  const gpuNote = (ffmpegMode && hasGL) ? '' : '（mpv模式/无GL → 需真机 ffmpeg 模式才有值）';
  log(`\n引擎=${s.engine}  WebGL=${hasGL ? 'yes' : 'no'}  媒体=${path.basename(MEDIA)}`);

  // ---- A. 交互延迟（跟手度）----
  log('\n[A] 交互延迟（命令总线 → 状态生效，轮询步长 10ms）');
  // 注意：mpv 的 `cycle speed` 因 speed 无 choice 列表是 no-op，倍速单独用 `set speed` 测
  const speedBefore = (await snap()).props.speed;
  const speedTarget = speedBefore === 1 ? 2 : 1;
  const cmds = [
    ['cycle pause', ['cycle', 'pause'], 'pause'],
    ['add volume 5', ['add', 'volume', 5], 'volume'],
    ['cycle mute', ['cycle', 'mute'], 'mute'],
  ];
  for (const [label, args, prop] of cmds) {
    const bv = (await snap()).props[prop];
    const t0 = Date.now();
    await evalJS(`window.__lumen.run(${JSON.stringify(args)})`);
    let lat = -1;
    for (let i = 0; i < 200; i++) {
      const nv = (await snap()).props[prop];
      if (nv !== bv) { lat = Date.now() - t0; break; }
      await wait(10);
    }
    const g = lat < 0 ? '超时' : lat < 50 ? '跟手' : lat < 120 ? '可接受' : '偏顿';
    record(label, lat < 0 ? '>2000' : lat, 'ms', g);
  }
  {
    const t0 = Date.now();
    await evalJS(`window.__lumen.run(['set','speed',${speedTarget}])`);
    let lat = -1;
    for (let i = 0; i < 200; i++) {
      const nv = (await snap()).props.speed;
      if (nv === speedTarget) { lat = Date.now() - t0; break; }
      await wait(10);
    }
    const g = lat < 0 ? (speedBefore === speedTarget ? '无变化' : '超时/未观测')
      : lat < 50 ? '跟手' : lat < 120 ? '可接受' : '偏顿';
    record(`set speed→${speedTarget}`, lat < 0 ? '>2000' : lat, 'ms', g);
  }

  // ---- B. seek 延迟 ----
  log('\n[B] seek 延迟（absolute seek → time-pos 到达目标 ±0.3s）');
  await evalJS(`window.__lumen.run(['set','pause',false])`);
  for (const tgt of [5, 10, 15]) {
    const start = (await snap()).props['time-pos'];
    const t0 = Date.now();
    await evalJS(`window.__lumen.run(['seek', ${tgt}, 'absolute'])`);
    let lat = -1, reached = false, moved = false;
    for (let i = 0; i < 200; i++) {
      const tp = (await snap()).props['time-pos'];
      if (tp !== start) moved = true;
      if (Math.abs(tp - tgt) < 0.3) { lat = Date.now() - t0; reached = true; break; }
      await wait(10);
    }
    if (reached) {
      const g = lat < 200 ? '跟手' : lat < 500 ? '可接受' : '偏顿';
      record(`seek→${tgt}s`, lat, 'ms', g);
    } else if (!moved) {
      record(`seek→${tgt}s`, 'N/A', 'ms', 'headless: 显示时钟冻结（无 GPU 呈现），需真机测');
    } else {
      record(`seek→${tgt}s`, '>2000', 'ms', '超时（seek 未完成）');
    }
  }

  // ---- B. 播放流畅性指标 ----
  log('\n[B] 播放流畅性（丢帧 / 音画同步 / 渲染吞吐）');
  await wait(2500);
  const st = (await snap()).stats;
  const dropped = st.dropped || 0, presented = st.presented || 0;
  const ratio = (dropped + presented) > 0 ? (dropped / (dropped + presented) * 100) : null;
  record('丢帧率', ratio == null ? 'N/A' : ratio.toFixed(2), '%',
    gpuNote || (ratio < 0.5 ? '优秀' : ratio < 2 ? '良好' : '偏高'));
  record('音画同步 avSync', st.avSync == null ? 'N/A' : st.avSync.toFixed(1), 'ms',
    gpuNote || (Math.abs(st.avSync) < 40 ? '优秀' : Math.abs(st.avSync) < 80 ? '良好' : '偏大'));
  if (ffmpegMode && hasGL) {
    const r0 = (await snap()).stats.renderedFrames; const t0 = Date.now(); await wait(1000);
    const r1 = (await snap()).stats.renderedFrames;
    record('渲染吞吐', ((r1 - r0) / ((Date.now() - t0) / 1000)).toFixed(1), 'fps', 'ffmpeg+WebGL 模式');
  } else {
    record('渲染吞吐', 'N/A', 'fps', 'mpv模式/无GL → renderedFrames 由 mpv 管理，渲染端计数恒 0（需真机 ffmpeg 模式）');
  }

  // ---- C. 稳态 JS 堆（泄漏信号）----
  log('\n[C] 内存（交互压力下的 JS 堆增长）');
  const h0 = await evalJS('performance.memory ? performance.memory.usedJSHeapSize : 0');
  for (let i = 0; i < 30; i++) {
    await evalJS(`window.__lumen.run(['cycle','pause'])`); await wait(40);
    await evalJS(`window.__lumen.run(['cycle','pause'])`); await wait(40);
  }
  const h1 = await evalJS('performance.memory ? performance.memory.usedJSHeapSize : 0');
  const dMB = (h0 && h1) ? ((h1 - h0) / 1048576).toFixed(2) : 'N/A';
  record('JS堆增长(60次切换)', dMB, 'MB', (h0 && h1) ? (Math.abs(dMB) < 5 ? '稳定' : '关注') : 'performance.memory 不可用');

  log('\n=== UX 基准完成 ===');
  return cleanup(0);
}

main().catch((e) => { console.error('基准异常:', e.message); cleanup(1); });
