// 频谱探针：加载音乐 → 读 analyser.getByteFrequencyData → 统计哪些频段有值
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const ROOT = process.cwd();
const EL = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const PORT = 9229;
const MUSIC = process.argv[2] || path.join(ROOT, 'testmedia-real', '音乐测试', '区瑞强-月亮代表我的心24bit96khz.wav');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ud-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cfg-'));
  const proc = spawn(EL, ['.', '--no-sandbox', '--disable-gpu-sandbox',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, `--config-dir=${configDir}`],
    { cwd: ROOT, stdio: 'ignore', windowsHide: true, env: { ...process.env, LUMEN_DUMP_AUDIO: path.join(ROOT, '_design_archive', 'dump-audio.f32') } });
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
  // 捕获渲染端未捕获异常与控制台错误（seek 后管线冻结多为异常导致）
  const errors = [];
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push('EXC: ' + (m.params.exceptionDetails && m.params.exceptionDetails.text) + ' ' + (m.params.exceptionDetails && m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || '').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push('ERR: ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160));
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        errors.push('LOG: ' + String(m.params.entry.text).slice(0, 160));
      }
    } catch {}
  });
  await ev('Runtime.enable');
  try { await ev('Log.enable'); } catch {}
  await sleep(3000);
  await ev(`window.lumen.load(${JSON.stringify(MUSIC)})`);
  await sleep(3000); // 播放中采样

  for (let i = 0; i < 3; i++) {
    const probe = await ev(`(() => {
      const s = window.__lumen.snapshot();
      const a = s.audio;
      return { t: a.mediaTime, sent: a.voiceSent, spec: a.spectrum };
    })()`);
    console.log('播放中采样' + i + ':', JSON.stringify(probe));
    await sleep(500);
  }

  // seek 后频谱是否异常（走真实命令链路 runCommand→player.seek→_applyEpoch→flush，
  // 与 UI 拖进度条完全一致；直接调 window.lumen.seek 会绕过 _applyEpoch 造成误报）
  const seekResp = await ev(`(async () => {
    try {
      const r = await window.__lumen.run(['seek', 30, 'absolute']);
      return { run: !!r, r: JSON.stringify(r) };
    } catch (e) { return { err: String(e && e.message || e) }; }
  })()`);
  console.log('seek 命令响应:', JSON.stringify(seekResp));
  await sleep(2500);
  for (let i = 0; i < 3; i++) {
    const probe = await ev(`(() => {
      const s = window.__lumen.snapshot();
      const a = s.audio;
      return { t: a.mediaTime, sent: a.voiceSent, spec: a.spectrum };
    })()`);
    console.log('seek后采样' + i + ':', JSON.stringify(probe));
    await sleep(500);
  }
  if (errors.length) console.log('渲染端异常:', errors.slice(0, 10).join(' | '));
  else console.log('渲染端异常: 无');

  // 用全局播放器探针：app.js 是否暴露了 player？找 window 上可用的引用
  const refs = await ev(`(() => {
    const out = {};
    const keys = Object.keys(window).filter(k => /player|audio|stage/i.test(k));
    out.windowKeys = keys.slice(0, 20);
    return out;
  })()`);
  console.log('window 引用:', JSON.stringify(refs));
  proc.kill(); await sleep(1200);
  fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
