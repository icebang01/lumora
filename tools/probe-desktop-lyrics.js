// 桌面歌词逐字着色探针：开桌面歌词 → seek(45) → 检查桌面窗口 span.lit 推进
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const ROOT = 'D:/IDEA/videos';
const MUSIC = 'D:/Users/Administrator/Music/音乐/G.E.M.邓紫棋-多远都要在一起.flac';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-dl-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-dl-cfg-'));
  const proc = spawn('npx', ['electron', '.', '--no-sandbox', '--disable-gpu-sandbox', '--remote-debugging-port=9251', `--user-data-dir=${userData}`, `--config-dir=${configDir}`], {
    cwd: ROOT, stdio: 'ignore', shell: true,
  });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try {
      const r = await fetch('http://127.0.0.1:9251/json');
      const list = await r.json();
      page = list.find((p) => p.type === 'page' && p.url.startsWith('file://') && !p.url.includes('desktop-lyrics'));
    } catch { /* not up yet */ }
  }
  if (!page) { console.log('CDP 主页面未就绪'); proc.kill(); process.exit(1); }
  const connect = async (pg) => {
    const ws = new WebSocket(pg.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0;
    const ev = (expression) => new Promise((resolve) => {
      const i = ++id;
      const h = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== i) return; ws.off('message', h); resolve(m.result && m.result.result ? m.result.result.value : m); };
      ws.on('message', h);
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    return { ws, ev };
  };
  const main = await connect(page);

  await sleep(2000);
  await main.ev(`window.lumen.load(${JSON.stringify(MUSIC)})`);
  await sleep(4000);
  await main.ev(`(() => { const o = document.querySelector('.mc-style-opt[data-style="lyrics-min"]'); if (o) o.click(); return !!o; })()`);
  await sleep(500);
  // 打开桌面歌词
  const toggled = await main.ev(`(async () => { try { const r = await window.lumen.desktopLyricsToggle(); return JSON.stringify(r); } catch (e) { return 'ERR ' + e.message; } })()`);
  console.log('桌面歌词开关:', JSON.stringify(toggled));
  await sleep(1500);
  await main.ev(`window.__lumen.run(['seek', 45, 'absolute'])`);
  await sleep(2000);

  // 找桌面歌词窗口 page
  let dlPage = null;
  for (let i = 0; i < 10 && !dlPage; i++) {
    await sleep(500);
    try {
      const r = await fetch('http://127.0.0.1:9251/json');
      const list = await r.json();
      dlPage = list.find((p) => p.type === 'page' && p.url.includes('desktop-lyrics'));
    } catch {}
  }
  if (!dlPage) { console.log('桌面歌词窗口未找到'); proc.kill(); process.exit(1); }
  const dl = await connect(dlPage);
  const sample = `(() => {
    const spans = document.querySelectorAll('#dl-current .dl-char');
    const lit = document.querySelectorAll('#dl-current .dl-char.lit').length;
    return JSON.stringify({ spans: spans.length, lit: lit + '/' + spans.length, text: (document.querySelector('#dl-current') || {}).textContent || '' });
  })()`;
  for (let i = 0; i < 4; i++) {
    const r = await dl.ev(sample);
    console.log('桌面采样' + i + ':', JSON.stringify(r));
    await sleep(2500);
  }
  // 截图桌面窗口
  {
    const shotId = 999;
    const shotP = new Promise((resolve) => {
      const h2 = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== shotId) return; dl.ws.off('message', h2); resolve(m.result && m.result.data); };
      dl.ws.on('message', h2);
      dl.ws.send(JSON.stringify({ id: shotId, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    const data = await shotP;
    if (data) { fs.writeFileSync(path.join(ROOT, '_design_archive', 'desktop-lyric-lit.png'), Buffer.from(data, 'base64')); console.log('桌面歌词截图已保存'); }
  }

  proc.kill(); await sleep(1000);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error('探针错误:', e); process.exit(1); });
