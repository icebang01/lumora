// 音乐控制台验证：隔离实例加载音乐 → 检查控制台 DOM 结构 → 截图
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const ROOT = process.cwd();
const EL = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const PORT = 9228;
const MUSIC = path.join(ROOT, 'testmedia-real', '音乐测试', '区瑞强-月亮代表我的心24bit96khz.wav');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ud-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  const proc = spawn(EL, ['.', '--no-sandbox', '--disable-gpu-sandbox',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, `--config-dir=${configDir}`],
    { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {}
    await sleep(500);
  }
  if (!page) { console.error('无页面'); proc.kill(); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const ev = (method, params = {}) => new Promise((resolve) => {
    const i = ++id;
    const h = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== i) return;
      ws.off('message', h); resolve(m.result); };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await sleep(3000);
  await ev('Runtime.evaluate', { expression: `window.lumen.load(${JSON.stringify(MUSIC)})`, awaitPromise: true });
  await sleep(3500);
  const dom = await ev('Runtime.evaluate', { expression: `(() => {
    const q = (s) => document.querySelector(s);
    const vis = (s) => { const e = q(s); return e ? getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' : false; };
    const order = [...document.querySelectorAll('#music-controls .mc-center > *')].map((e) => e.id || e.dataset.cmd || e.className);
    return {
      audioMode: document.body.className.includes('audio-mode'),
      stageVisible: vis('#music-stage'),
      controlsVisible: vis('#music-controls'),
      centerOrder: order,
      hasSpeed: !!q('#m-btn-speed'),
      speedLabel: q('#m-btn-speed') ? q('#m-btn-speed').textContent : null,
      playBg: (() => { const e = q('.mc-btn--primary'); return e ? getComputedStyle(e).backgroundImage.slice(0, 55) : null; })(),
      repeatInCenter: !!q('.mc-center #m-btn-repeat'),
      castInRight: !!q('.mc-right #m-btn-cast'),
      artVisible: vis('.ms-art'),
      lyricsVisible: vis('.ms-lyrics-wrap'),
    };
  })()`, returnByValue: true });
  console.log('控制台 DOM:', JSON.stringify(dom.result.value, null, 1));
  const shot = await ev('Page.captureScreenshot', { format: 'png' });
  const out = path.join(ROOT, '_design_archive', 'music-console-landed.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图:', out);
  proc.kill(); await sleep(1200);
  fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
