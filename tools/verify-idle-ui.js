// 主页 UI 落地验证：隔离实例启动 → 等 idle 舞台 → CDP 截图 + DOM 状态检查
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const ROOT = process.cwd();
const EL = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const PORT = 9227;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ud-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-cfg-'));
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
  await sleep(4000);
  // DOM 结构检查
  const dom = await ev('Runtime.evaluate', { expression: `(() => {
    const q = (s) => !!document.querySelector(s);
    const g = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
    const sideRing = g('.idle-side-ring');
    const mark = g('.idle-mark');
    const actions = g('.idle-actions');
    const card = g('.idle-card');
    return {
      idle: document.body.classList.contains('idle-mode') || q('#idle-screen'),
      stageBg: q('.idle-stage-bg'),
      sideLabels: q('.idle-side-label'),
      sideArrows: q('.idle-side-arrow'),
      ringBorder: sideRing ? sideRing.borderTopWidth + ' ' + sideRing.borderTopColor : null,
      ringBg: sideRing ? sideRing.backgroundColor : null,
      markSize: mark ? mark.width + 'x' + mark.height : null,
      markShadow: mark ? mark.boxShadow.slice(0, 60) : null,
      actionsDir: actions ? actions.flexDirection : null,
      actionRadius: g('.idle-action') ? g('.idle-action').borderRadius : null,
      primaryColor: g('.idle-action--primary') ? g('.idle-action--primary').color : null,
      cardBg: card ? card.backgroundColor + ' / ' + card.boxShadow.slice(0, 40) : null,
      titleSize: g('.idle-title') ? g('.idle-title').fontSize : null,
      titleFont: g('.idle-title') ? g('.idle-title').fontWeight : null,
      stageCols: g('.idle-stage') ? g('.idle-stage').gridTemplateColumns : null,
      divider: (() => { const s = getComputedStyle(document.querySelector('.idle-stage')); return s.getPropertyValue('--x') || '::before@' + getComputedStyle(document.querySelector('.idle-stage'), '::before').left + ' ::after@' + getComputedStyle(document.querySelector('.idle-stage'), '::after').left; })(),
    };
  })()`, returnByValue: true });
  console.log('DOM 状态:', JSON.stringify(dom.result.value, null, 1));
  // 截图
  const shot = await ev('Page.captureScreenshot', { format: 'png' });
  const out = path.join(ROOT, '_design_archive', 'idle-landed-check.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图已存:', out);
  proc.kill(); await sleep(1200);
  fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
