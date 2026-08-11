// 歌词跟随综合验证：加载 → seek(45) → 播放 → 采样 tp + activeIdx + 期望行对照
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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-fl-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-fl-cfg-'));
  const proc = spawn('npx', ['electron', '.', '--no-sandbox', '--disable-gpu-sandbox', '--remote-debugging-port=9240', `--user-data-dir=${userData}`, `--config-dir=${configDir}`], {
    cwd: ROOT, stdio: 'ignore', shell: true,
  });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try {
      const r = await fetch('http://127.0.0.1:9240/json');
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
  await sleep(4000);
  await ev(`(() => { const o = document.querySelector('.mc-style-opt[data-style="lyrics-min"]'); if (o) o.click(); return !!o; })()`);
  await sleep(500);
  await ev(`window.__lumen.run(['seek', 45, 'absolute'])`);
  await sleep(1200);

  const sample = `(() => {
    const s = window.__lumen.snapshot();
    const tp = s.props ? s.props['time-pos'] : null;
    const lines = document.querySelectorAll('.ms-lyrics .ms-lyric-line');
    let ai = -1, txt = '', prog = null, litN = 0, charN = 0, curI = -1;
    lines.forEach((el, i) => { if ((el.className || '').includes('active')) { ai = i; txt = (el.textContent || '').slice(0, 16); prog = el.style.getPropertyValue('--prog');
      const chs = el.querySelectorAll('.ms-lyric-char'); charN = chs.length; litN = el.querySelectorAll('.ms-lyric-char.lit').length; curI = el.querySelector('.ms-lyric-char.cur') ? Array.prototype.indexOf.call(chs, el.querySelector('.ms-lyric-char.cur')) : -1; } });
    // 期望行：LRC 时间戳（G.E.M. 歌的已知时间表）
    return JSON.stringify({ tp: tp ? Number(tp).toFixed(1) : null, ai, txt, prog: prog ? Number(prog).toFixed(2) : null, lit: litN + '/' + charN, cur: curI });
  })()`;
  for (let i = 0; i < 4; i++) {
    const r = await ev(sample);
    console.log('采样' + i + ':', JSON.stringify(r));
    await sleep(2500);
  }
  // 截图：active 行逐字点亮效果
  {
    const shotId = ++id;
    const shotP = new Promise((resolve) => {
      const h2 = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== shotId) return; ws.off('message', h2); resolve(m.result && m.result.data); };
      ws.on('message', h2);
      ws.send(JSON.stringify({ id: shotId, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    const data = await shotP;
    if (data) { fs.writeFileSync(path.join(ROOT, '_design_archive', 'lyric-lit.png'), Buffer.from(data, 'base64')); console.log('截图已保存 lyric-lit.png'); }
  }

  proc.kill(); await sleep(1000);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error('探针错误:', e); process.exit(1); });
