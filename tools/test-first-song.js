// 首曲无声回归实测：全新实例 → 加载第一首音乐 → 检查音频管线是否真的在出声
// 用法：node tools/test-first-song.js [音乐文件路径]
// 判定依据（程序化"听声"）：声部 sentFrames 增长 + mediaTime 推进 + ctx running
//   = 块被声部接受并送进 worklet。若 sentFrames 恒 0 → 块被 epoch 错配丢弃（无声）。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MUSIC = process.argv[2] || path.join(ROOT, 'testmedia-real', '音乐测试', '区瑞强-月亮代表我的心24bit96khz.wav');
const PORT = 9223;
const USER_DATA = path.join(ROOT, `.firstsong-ud-${process.pid}`);

if (!fs.existsSync(MUSIC)) { console.error('音乐文件不存在:', MUSIC); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      if (r.ok) {
        const targets = await r.json();
        // 主窗口页面（视频窗口是 data:text/html 透明页，必须排除）
        const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
        if (page) return page;
      }
    } catch { /* 未就绪 */ }
    await sleep(500);
  }
  throw new Error('CDP 主页面目标未出现（index.html）');
}

function evaluate(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = ++evaluate._id || 1;
    evaluate._id = id;
    const timer = setTimeout(() => reject(new Error('evaluate 超时: ' + expression.slice(0, 60))), 8000);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
}

async function main() {
  console.log('音乐文件:', MUSIC);
  console.log('userData:', USER_DATA);
  const proc = spawn(ELECTRON, ['.', '--no-sandbox', '--disable-gpu-sandbox',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
  });

  let ws = null;
  try {
    const page = await waitCdp();
    console.log('页面目标:', page.title || page.url.slice(0, 60));
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    // 等渲染端 boot 完成（__lumen 快照就绪 + 稳定 2 秒）
    for (let i = 0; i < 40; i++) {
      const ok = await evaluate(ws, `!!(window.__lumen && window.__lumen.snapshot)`);
      if (ok) break;
      await sleep(500);
    }
    await sleep(2000);

    console.log('→ 加载第一首音乐（无任何前置手势，等价首启首曲时序）…');
    let loadR = null;
    for (let attempt = 1; attempt <= 3 && !(loadR && loadR.ok); attempt++) {
      loadR = await evaluate(ws, `window.lumen.load(${JSON.stringify(MUSIC)})
        .then(r => ({ ok: !!r && !!r.ok, err: r && r.error, src: r && r.source }))
        .catch(e => ({ ok: false, err: String(e && e.message || e) }))`);
      console.log(`load 第 ${attempt} 次:`, JSON.stringify(loadR));
      if (!(loadR && loadR.ok)) await sleep(2000);
    }
    if (!(loadR && loadR.ok)) throw new Error('音乐加载失败: ' + JSON.stringify(loadR));

    const samples = [];
    for (let i = 0; i < 12; i++) { // 6 秒采样
      await sleep(500);
      const s = await evaluate(ws, `(() => { const x = window.__lumen.snapshot(); return {
        engine: x.engine, hasFile: x.hasFile, state: x.audio.state, mediaTime: x.audio.mediaTime,
        worklet: x.audio.worklet, buffered: x.audio.buffered, underruns: x.audio.underruns,
        voiceEpoch: x.audio.voiceEpoch, voiceSent: x.audio.voiceSent, voiceDropped: x.audio.voiceDropped,
        transportEpoch: x.transport.epoch, propsPause: x.props.pause, timePos: x.props['time-pos'],
      }; })()`);
      samples.push(s);
    }

    console.log('\n=== 采样（每 0.5s）===');
    for (const s of samples) {
      console.log(JSON.stringify(s));
    }

    const last = samples[samples.length - 1];
    const sent = samples.map((s) => s.voiceSent).filter((n) => n > 0);
    const mediaAdvancing = samples.length > 2 &&
      samples[samples.length - 1].mediaTime > samples[0].mediaTime;
    const ctxRunning = samples.some((s) => s.state === 'running');

    console.log('\n=== 判定 ===');
    console.log('ctx running:', ctxRunning ? '✓' : '✗');
    console.log('声部收到并发送块（sentFrames>0）:', sent.length ? `✓ (${sent[sent.length - 1]})` : '✗ 全部被丢弃');
    console.log('mediaTime 推进:', mediaAdvancing ? '✓' : '✗');
    console.log('underruns:', last.underruns, '| voiceEpoch:', last.voiceEpoch, '| transportEpoch:', last.transportEpoch);
    const pass = ctxRunning && sent.length > 0 && mediaAdvancing;
    console.log('\n结果:', pass ? '✅ PASS —— 音频管线在出声（首曲无声已修复）' : '❌ FAIL —— 无声（块被丢弃）');
    process.exitCode = pass ? 0 : 1;
  } finally {
    try { if (ws) ws.close(); } catch { /* */ }
    proc.kill();
    await sleep(1500);
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('测试失败:', e.message); process.exit(1); });
