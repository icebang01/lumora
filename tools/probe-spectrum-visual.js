// 频谱视觉层探针：加载真实音乐 → 检查 ms-art/m-spectrum 实际渲染尺寸、
// 遮挡关系（elementFromPoint）、canvas 内部像素尺寸 → 截图
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const ROOT = process.cwd();
const EL = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const PORT = 9230;
const MUSIC = process.argv[2] || 'D:/Users/Administrator/Music/音乐/BY2-凑热闹.flac';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'spv-ud-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spv-cfg-'));
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
  const ev = (expression) => new Promise((resolve) => {
    const i = ++id;
    const h = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== i) return;
      ws.off('message', h); resolve(m.result && m.result.result ? m.result.result.value : m); };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  const errors = [];
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push('EXC@' + (d && d.lineNumber) + ':' + (d && d.columnNumber) + ' ' + (d && d.exception && d.exception.description || d && d.text || '').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const txt = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
        if (m.params.type === 'error' || txt.includes('[lumen]') || txt.includes('probe-marker')) {
          errors.push((m.params.type.toUpperCase() + ': ') + txt.slice(0, 200));
        }
      }
    } catch {}
  });
  await ev('Runtime.enable');
  await sleep(500);
  // 页面内收集 console（绕开 CDP 事件通道，最可靠）
  await ev(`(() => {
    if (!window.__consoleLog) {
      window.__consoleLog = [];
      const types = ['log', 'warn', 'error'];
      for (const t of types) {
        const orig = console[t].bind(console);
        console[t] = (...a) => {
          window.__consoleLog.push(t.toUpperCase() + ': ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
          orig(...a);
        };
      }
    }
  })()`);
  await sleep(2000);
  // 探针自己监听 player:loaded，直接看事件是否触发及其 payload
  await ev(`(() => {
    if (!window.__probeLoaded) {
      window.__probeLoaded = 'not-yet';
      window.lumen.on('player:loaded', (p) => {
        window.__probeLoaded = JSON.stringify({ src: p && p.source, audioOnly: p && p.info && p.info.audioOnly, hasInfo: !!p.info });
      });
    }
  })()`);
  await ev(`window.lumen.load(${JSON.stringify(MUSIC)})`);
  await sleep(3500);
  // square 默认样式下先验证 cover 频谱（HTML 结构修复后应恢复显示）
  const covPre = await ev(`(() => {
    const c = document.getElementById('m-spectrum');
    const chain = []; let cur = c; while (cur && cur.nodeType === 1 && chain.length < 5) { chain.push(cur.id || String(cur.className) || cur.tagName); cur = cur.parentElement; }
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    const cs = getComputedStyle(c);
    return JSON.stringify({ parent: chain[1] || '?', chain: chain.join(' < '), disp: cs.display, offParent: c.offsetParent ? 'ok' : 'null', px: c.width + 'x' + c.height, opaque: n });
  })()`);
  console.log('square 默认 cover 频谱:', JSON.stringify(covPre));
  // 切 vinyl 样式：验证控制条按钮深色化（浅背景适配）
  await ev(`(() => {
    const opt = document.querySelector('.mc-style-opt[data-style="vinyl"]');
    if (opt) { opt.click(); return 'clicked'; }
    return 'no-opt';
  })()`);
  await sleep(600);
  const vin = await ev(`(() => {
    const btn = document.querySelector('#music-controls .mc-btn');
    const cs = btn ? getComputedStyle(btn) : null;
    const title = document.querySelector('#m-track-title');
    const tcs = title ? getComputedStyle(title) : null;
    const wrap = document.getElementById('m-spectrum-lyrics-wrap');
    return JSON.stringify({ bodyClass: document.body.className, btnColor: cs ? cs.color : null, btnBg: cs ? cs.backgroundColor : null, titleColor: tcs ? tcs.color : null, lyricsWrapDisp: wrap ? getComputedStyle(wrap).display : null });
  })()`);
  console.log('vinyl 控制条:', JSON.stringify(vin));
  // vinyl 状态截图（视觉确认控制条按钮可见）
  {
    const shot = await ev('new Promise((res) => setTimeout(() => res(null), 50))');
    const shotId = ++id;
    const shotP = new Promise((resolve) => {
      const h2 = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== shotId) return; ws.off('message', h2); resolve(m.result && m.result.data); };
      ws.on('message', h2);
      ws.send(JSON.stringify({ id: shotId, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    const data = await shotP;
    if (data) { fs.writeFileSync(path.join(ROOT, '_design_archive', 'vinyl-controls.png'), Buffer.from(data, 'base64')); console.log('vinyl 截图已保存'); }
  }
  // 切到 lyrics-min 样式（歌词底部频谱可见），验证频谱绘制
  await ev(`(() => {
    const opt = document.querySelector('.mc-style-opt[data-style="lyrics-min"]');
    if (opt) { opt.click(); return 'clicked'; }
    return 'no-opt';
  })()`);
  await sleep(800);
  const evt = await ev(`window.__probeLoaded`);
  console.log('player:loaded 事件:', JSON.stringify(evt));
  const audio = await ev(`(() => {
    const a = window.__lumen.snapshot().audio;
    return { t: a.mediaTime, sent: a.voiceSent, worklet: a.worklet, state: a.state, spec: a.spectrum ? a.spectrum.nonzero + 'bins' : null };
  })()`);
  console.log('音频状态:', JSON.stringify(audio));

  const dom = await ev(`(() => {
    try {
    const stage = document.querySelector('#music-stage');
    const lyrWrap = document.getElementById('m-spectrum-lyrics-wrap');
    const lyrSpec = document.getElementById('m-spectrum-lyrics');
    const covSpec = document.getElementById('m-spectrum');
    // 祖先链 display 检查（offsetParent null 的根源）
    const chain = (el) => { if (!el) return 'none'; const out = [];
      let cur = el; while (cur && cur.nodeType === 1 && out.length < 8) { const cs = getComputedStyle(cur);
        out.push((cur.id || cur.className || cur.tagName) + ':' + cs.display + ':' + cs.position); cur = cur.parentElement; }
      return out; };
    // 遮挡检查：wrapper 内多个点 elementFromPoint
    const lyr = document.querySelector('.ms-lyrics-wrap, .ms-lyrics');
    const ctrl = document.querySelector('#music-controls');
    const wrapRect = lyrWrap ? lyrWrap.getBoundingClientRect() : null;
    let cover = null;
    if (wrapRect && wrapRect.width > 0) {
      const pts = [[0.5, 0.3], [0.5, 0.6], [0.5, 0.9], [0.2, 0.5], [0.8, 0.5]];
      cover = pts.map(([fx, fy]) => {
        const el = document.elementFromPoint(wrapRect.x + wrapRect.width * fx, wrapRect.y + wrapRect.height * fy);
        return (el ? (el.id || el.className || el.tagName) : 'null');
      });
    }
    const zz = (el) => el ? getComputedStyle(el).zIndex : null;
    const covSpec = document.getElementById('m-spectrum');
    return {
      dpr: window.devicePixelRatio,
      stageClass: stage ? stage.className : null,
      stagePos: stage ? getComputedStyle(stage).position : null,
      coverOffsetParent: covSpec ? (covSpec.offsetParent ? (covSpec.offsetParent.id || covSpec.offsetParent.className || 'other') : 'null') : null,
      lyricsOffsetParent: lyrSpec ? (lyrSpec.offsetParent ? (lyrSpec.offsetParent.id || lyrSpec.offsetParent.className || 'other') : 'null') : null,
      lyricsWrapPos: lyrWrap ? getComputedStyle(lyrWrap).position : null,
      coverChain: chain(covSpec),
      lyricsChain: chain(lyrSpec),
      stageClass: stage ? stage.className : null,
      lyricsWrapDisp: lyrWrap ? getComputedStyle(lyrWrap).display : null,
      lyricsWrapRect: wrapRect ? Math.round(wrapRect.x) + ',' + Math.round(wrapRect.y) + ' ' + Math.round(wrapRect.width) + 'x' + Math.round(wrapRect.height) : null,
      lyricsCanvas: lyrSpec ? lyrSpec.width + 'x' + lyrSpec.height : null,
      wrapCoveredBy: cover,
      lyricsZ: zz(lyr), lyricsRect: lyr ? (() => { const b = lyr.getBoundingClientRect(); return Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height); })() : null,
      controlsZ: zz(ctrl),
      canvasZ: zz(lyrSpec),
      canvasPos: lyrSpec ? getComputedStyle(lyrSpec).position : null,
    };
    } catch (e) { return { evalErr: String(e && e.message || e) }; }
  })()`);
  console.log('遮挡检查:', JSON.stringify(dom, null, 1));

  // 单独查祖先链 display（避开序列化问题）
  const chn = await ev(`(() => {
    const chain = (el) => { if (!el) return 'none'; const out = [];
      let cur = el; while (cur && cur.nodeType === 1 && out.length < 8) { const cs = getComputedStyle(cur);
        out.push((cur.id || String(cur.className) || cur.tagName) + ':' + cs.display + ':' + cs.position); cur = cur.parentElement; }
      return out.join(' < '); };
    const wr = document.getElementById('m-spectrum-lyrics-wrap');
    const b = wr ? wr.getBoundingClientRect() : null;
    return JSON.stringify({ dpr: devicePixelRatio, wrapRect: b ? Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height) : null, cover: chain(document.getElementById('m-spectrum')), lyrics: chain(document.getElementById('m-spectrum-lyrics')) });
  })()`);
  console.log('祖先链:', JSON.stringify(chn));

  // 直接读两个频谱 canvas 的实际像素内容
  const px = await ev(`(() => {
    const read = (id) => {
      const c = document.getElementById(id);
      if (!c) return 'no-canvas';
      const ctx = c.getContext('2d');
      try {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let opaque = 0, bright = 0;
        for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) opaque++; if (d[i] > 40) bright++; }
        return { px: c.width + 'x' + c.height, opaque, bright, nonTransparent: (opaque / (c.width * c.height) * 100).toFixed(2) + '%' };
      } catch (e) { return 'ERR ' + e.message; }
    };
    return { cover: read('m-spectrum'), lyrics: read('m-spectrum-lyrics') };
  })()`);
  console.log('canvas 像素:', JSON.stringify(px));

  // 验证 reduced-motion 假设：系统是否开启"减少动态效果"
  const rm = await ev(`(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const spec = document.getElementById('m-spectrum');
    const ctx = spec ? spec.getContext('2d') : null;
    // 手动画一根高柱测试 canvas 是否可写
    let manual = null;
    if (ctx) {
      try {
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.fillRect(10, 10, 20, 60);
        const d = ctx.getImageData(15, 40, 1, 1).data;
        manual = d[3] > 0 ? '可写' : '不可写';
      } catch (e) { manual = 'ERR ' + e.message; }
    }
    return { reducedMotion: m.matches, manual };
  })()`);
  console.log('reduced-motion:', JSON.stringify(rm));

  // rAF 计数：monkey-patch 后等 600ms，看回调是否被持续调用
  const raf = await ev(`(async () => {
    let calls = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => orig((t) => { calls++; cb(t); });
    const before = calls;
    await new Promise((r) => setTimeout(r, 600));
    return { during600ms: calls - before };
  })()`);
  console.log('rAF 600ms 内回调次数:', JSON.stringify(raf));

  // 区分测试：MutationObserver 兜底（_setupSpectrum 挂的）会在 wrapper
  // style/class 变化时调 _resizeSpectrum+_drawSpectrum。手动触发一次，
  // 若 canvas 变亮 → _drawSpectrum 正常、问题在 rAF 循环未启动；
  // 若仍不变 → _drawSpectrum 本身画不出内容。
  const trig = await ev(`(async () => {
    const wrap = document.getElementById('m-spectrum-lyrics-wrap');
    const c = document.getElementById('m-spectrum-lyrics');
    const ctx = c.getContext('2d');
    const count = () => { const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
    const before = count();
    wrap.style.outline = '1px solid transparent';   // 触发属性变更
    await new Promise((r) => setTimeout(r, 300));
    const after = count();
    wrap.style.outline = '';
    return { before, after, delta: after - before };
  })()`);
  console.log('MutationObserver 触发绘制:', JSON.stringify(trig));

  // rAF 是否活着：两次采样对比非透明像素变化；同时分析现有像素形状
  const alive = await ev(`(async () => {
    const c = document.getElementById('m-spectrum-lyrics');
    const ctx = c.getContext('2d');
    const sig = () => {
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0; const box = { minX: 1e9, minY: 1e9, maxX: -1, maxY: -1 };
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 0) {
            n++;
            if (x < box.minX) box.minX = x; if (x > box.maxX) box.maxX = x;
            if (y < box.minY) box.minY = y; if (y > box.maxY) box.maxY = y;
          }
        }
      }
      return { n, box: n ? box : null };
    };
    const s1 = sig();
    await new Promise((r) => setTimeout(r, 400));
    const s2 = sig();
    return { t0: s1, t1: s2, changed: s1.n !== s2.n };
  })()`);
  console.log('rAF 活性:', JSON.stringify(alive));

  const shot = await ev(`(async () => {
    const s = document.querySelector('.ms-art');
    const b = s.getBoundingClientRect();
    return null;
  })()`);
  const shot2 = await (() => { // 截整个页面
    return new Promise((resolve) => {
      const i = ++id;
      const h = (raw) => { const m = JSON.parse(raw.toString()); if (m.id !== i) return; ws.off('message', h); resolve(m.result); };
      ws.on('message', h);
      ws.send(JSON.stringify({ id: i, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
  })();
  const out = path.join(ROOT, '_design_archive', 'spectrum-visual.png');
  fs.writeFileSync(out, Buffer.from(shot2.data, 'base64'));
  console.log('截图:', out);
  const logs = await ev(`(() => {
    const arr = window.__consoleLog || [];
    return arr.filter((l) => l.includes('[lumen][spec]') || l.includes('[lumen][stage]') || l.includes('ERROR') || l.includes('WARN')).slice(-20);
  })()`);
  console.log('spec/stage 日志:', JSON.stringify(logs, null, 1));
  // 读模块内部频谱状态（import() 同 URL 返回缓存实例，不会重复初始化）
  const dbg = await ev(`(async () => {
    try {
      const mod = await import('./ui/music-stage.js');
      return typeof mod.__specDebug === 'function' ? mod.__specDebug() : 'no-export';
    } catch (e) { return 'ERR ' + e.message; }
  })()`);
  console.log('模块内部状态:', JSON.stringify(dbg));
  // 手动触发一次绘制，看是否成功 + canvas 是否变化
  const once = await ev(`(async () => {
    const mod = await import('./ui/music-stage.js');
    const before = (() => { const c = document.getElementById('m-spectrum-lyrics'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })();
    const r = typeof mod.__specDrawOnce === 'function' ? mod.__specDrawOnce() : 'no-export';
    await new Promise((res) => setTimeout(res, 200));
    const after = (() => { const c = document.getElementById('m-spectrum-lyrics'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })();
    return { draw: r, before, after };
  })()`);
  console.log('手动绘制:', JSON.stringify(once));
  // 复刻 isLyrics 绘制（渐变+shadow+fillRect vs roundRect）定位画不出的具体环节
  const rep = await ev(`(() => {
    const c = document.getElementById('m-spectrum-lyrics');
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const read = () => { const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 700, 150);
    const before = read();
    // A: 渐变 fillRect
    const grad = ctx.createLinearGradient(0, 150, 0, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.98)');
    grad.addColorStop(0.55, 'rgba(255,185,210,0.95)');
    grad.addColorStop(1, 'rgba(255,145,185,0.90)');
    ctx.fillStyle = grad;
    ctx.fillRect(24, 100, 50, 50);
    const afterA = read();
    // B: 纯色 fillRect
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(200, 100, 50, 50);
    const afterB = read();
    // C: shadow 是否导致问题
    ctx.shadowBlur = 14;
    ctx.shadowColor = 'rgba(255,160,200,0.65)';
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(400, 100, 50, 50);
    const afterC = read();
    ctx.shadowBlur = 0;
    // D: roundRect 路径（arcTo）
    ctx.fillStyle = '#0000ff';
    ctx.beginPath();
    ctx.moveTo(600 + 3, 100);
    ctx.arcTo(600 + 50, 100, 600 + 50, 150, 3);
    ctx.arcTo(600 + 50, 150, 600, 150, 3);
    ctx.arcTo(600, 150, 600, 100, 3);
    ctx.arcTo(600, 100, 600 + 50, 100, 3);
    ctx.closePath();
    ctx.fill();
    const afterD = read();
    return { before, A_gradFill: afterA, B_solidFill: afterB, C_shadow: afterC, D_roundRect: afterD };
  })()`);
  console.log('绘制复刻:', JSON.stringify(rep));
  console.log('未捕获异常:', errors.length ? errors.slice(0, 12).join('\n  ') : '无');
  proc.kill(); await sleep(1200);
  fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
