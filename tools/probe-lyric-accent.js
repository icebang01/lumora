// 歌词着色跟随播放键色验证：切 vinyl(橙)/lyrics-min(粉) 读 lit/cur computed color
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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-ac-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-ac-cfg-'));
  const proc = spawn('npx', ['electron', '.', '--no-sandbox', '--disable-gpu-sandbox', '--remote-debugging-port=9253', `--user-data-dir=${userData}`, `--config-dir=${configDir}`], {
    cwd: ROOT, stdio: 'ignore', shell: true,
  });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { const r = await fetch('http://127.0.0.1:9253/json'); const list = await r.json(); page = list.find((p) => p.type === 'page' && p.url.startsWith('file://')); } catch {}
  }
  if (!page) { console.log('CDP 未就绪'); proc.kill(); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const ev = (expression) => new Promise((resolve) => {
    const i = ++id;
    const h = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== i) return; ws.off('message', h); resolve(m.result && m.result.result ? m.result.result.value : m); };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });

  await sleep(2000);
  await ev(`window.lumen.load(${JSON.stringify(MUSIC)})`);
  await sleep(4000);
  await ev(`(() => { const o = document.querySelector('.mc-style-opt[data-style="lyrics-min"]'); if (o) o.click(); return !!o; })()`);
  await sleep(500);
  await ev(`window.__lumen.run(['seek', 47, 'absolute'])`);
  await sleep(1500);

  const sample = `(() => {
    const act = document.querySelector('.ms-lyric-line.active');
    const lit = act ? act.querySelector('.ms-lyric-char.lit') : null;
    const cur = act ? act.querySelector('.ms-lyric-char.cur') : null;
    const btn = document.querySelector('.mc-btn--primary');
    const btnBg = btn ? getComputedStyle(btn).backgroundImage : null;
    const accent = getComputedStyle(document.body).getPropertyValue('--style-accent').trim();
    return JSON.stringify({ accent, btnBg: (btnBg || '').slice(0, 60), litColor: lit ? getComputedStyle(lit).color : null, curColor: cur ? getComputedStyle(cur).color : null });
  })()`;
  const s1 = await ev(sample);
  console.log('lyrics-min(粉):', JSON.stringify(s1));
  await ev(`(() => { const o = document.querySelector('.mc-style-opt[data-style="vinyl"]'); if (o) o.click(); return !!o; })()`);
  await sleep(800);
  const s2 = await ev(sample);
  console.log('vinyl(橙):', JSON.stringify(s2));
  await ev(`(() => { const o = document.querySelector('.mc-style-opt[data-style="square"]'); if (o) o.click(); return !!o; })()`);
  await sleep(800);
  const s3 = await ev(sample);
  console.log('square(青绿):', JSON.stringify(s3));

  proc.kill(); await sleep(800);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error('探针错误:', e); process.exit(1); });
