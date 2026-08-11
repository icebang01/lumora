// 探针：复刻 run-smoke 启动参数，检查 pendingFile 是否传递、手动 load 是否可行
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const ROOT = process.cwd();
const EL = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const PORT = 9226;
const MEDIA = path.join(ROOT, 'testmedia', 'sdr-1080p.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-ud-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cfg-'));
  const proc = spawn(EL, ['.', '--no-sandbox', '--disable-gpu-sandbox',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, `--config-dir=${configDir}`,
    '--smoke-test=15', MEDIA], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
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
  const ev = (expression) => new Promise((resolve) => {
    const i = ++id;
    const h = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== i) return;
      ws.off('message', h); resolve(m.result && m.result.result ? m.result.result.value : m); };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  await sleep(3000);
  console.log('__pendingFile:', JSON.stringify(await ev('window.__pendingFile || null')));
  const s = await ev('window.__lumen.snapshot()');
  console.log('snap:', JSON.stringify({ hasFile: s.hasFile, idle: s.props['idle-active'], engine: s.engine, t: s.props['time-pos'] }));
  console.log('手动 load…');
  const r = await ev(`window.lumen.load(${JSON.stringify(MEDIA)}).then(r => ({ok: !!r && !!r.ok, src: r && r.source, err: r && r.error})).catch(e => ({ok:false, err:String(e)}))`);
  console.log('手动 load:', JSON.stringify(r));
  await sleep(4000);
  const s2 = await ev('window.__lumen.snapshot()');
  console.log('load 后 snap:', JSON.stringify({ hasFile: s2.hasFile, idle: s2.props['idle-active'], t: s2.props['time-pos'], voErr: s2.voError }));
  proc.kill(); await sleep(1200);
  fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('PROBE ERR', e); process.exit(1); });
