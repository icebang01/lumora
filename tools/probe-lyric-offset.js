// 歌词偏移探针：加载 G.E.M. 多远都要在一起 → 读自动校准值 + seek(55) 验证歌词行
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const ROOT = 'D:/IDEA/videos';
const MUSIC = process.argv[2] || 'D:/Users/Administrator/Music/音乐/G.E.M.邓紫棋-多远都要在一起.flac';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-lyr2-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-lyr2-cfg-'));
  const proc = spawn('npx', ['electron', '.', '--no-sandbox', '--disable-gpu-sandbox', '--remote-debugging-port=9224', `--user-data-dir=${userData}`, `--config-dir=${configDir}`], {
    cwd: ROOT, stdio: 'ignore', shell: true,
  });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try {
      const r = await fetch('http://127.0.0.1:9224/json');
      const list = await r.json();
      page = list.find((p) => p.type === 'page' && p.url.startsWith('file://'));
    } catch { /* not up yet */ }
  }
  if (!page) { console.log('CDP 页面未就绪'); proc.kill(); process.exit(1); }
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

  await sleep(2000);
  await ev(`window.lumen.load(${JSON.stringify(MUSIC)})`);
  await sleep(5000); // 等歌词加载 + 自动校准（ffmpeg 检测约需数秒）
  await ev(`(() => { const o = document.querySelector('.mc-style-opt[data-style="lyrics-min"]'); if (o) o.click(); return !!o; })()`);
  await sleep(800);

  // 1. 读自动校准结果 + 手动偏移
  const cal = await ev(`(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('lumen:lyric'));
    const vals = {};
    keys.forEach((k) => { vals[k.slice(0, 60)] = localStorage.getItem(k); });
    return JSON.stringify(vals);
  })()`);
  console.log('校准缓存:', JSON.stringify(cal));

  // 2. 直接调主进程校准接口看返回
  const off = await ev(`(async () => {
    try { const r = await window.lumen.lyricAutoOffset(${JSON.stringify(MUSIC)}, 14.38); return JSON.stringify(r); }
    catch (e) { return 'ERR ' + e.message; }
  })()`);
  console.log('主进程校准返回:', JSON.stringify(off));

  // 3. seek 到 55s（真实链路），采样歌词行
  await ev(`window.__lumen.run(['seek', 55, 'absolute'])`);
  await sleep(1500);
  const s55 = await ev(`(() => {
    const snap = window.__lumen.snapshot();
    const t = snap.audio ? snap.audio.mediaTime : null;
    const lines = document.querySelectorAll('.ms-lyrics .ms-lyric-line');
    let activeIdx = -1, activeText = '';
    lines.forEach((el, i) => { if ((el.className || '').includes('active')) { activeIdx = i; activeText = (el.textContent || '').slice(0, 20); } });
    return JSON.stringify({ t, activeIdx, activeText, lineCount: lines.length,
      all: Array.from(lines).slice(0, 14).map((el, i) => i + ':' + (el.textContent || '').slice(0, 12)) });
  })()`);
  console.log('seek55 采样:', JSON.stringify(s55));

  proc.kill(); await sleep(1000);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error('探针错误:', e); process.exit(1); });
