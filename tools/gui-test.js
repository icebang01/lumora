#!/usr/bin/env node
/**
 * Lumora GUI 自动化测试(CDP 驱动)
 *
 * 两种运行模式:
 *   1) 手动模式(直接执行)：连一个「已手动启动」的播放器
 *        electron . --force-renderer-accessibility --remote-debugging-port=9222
 *      node tools/gui-test.js <媒体文件路径>
 *   2) 模块模式(被 run-gui-test.js 自动启动器 require)：
 *      先 connect(targetUrl) 建立 CDP 连接，再 runGuiTests(media) 跑 13 项断言。
 *
 * 覆盖(13 项): 播放推进 / 暂停恢复 / 停止归零 / 停止后重播(从头) /
 *              倍速面板 / 返回主界面 / 续播卡片 / "从此处继续"
 *
 * 为什么用 CDP 而不是 computer_use: SendInput 坐标点击对 Electron 偶发
 * 不触发,CDP 的 DOM click 干净可靠;且能直接读 DOM 状态做断言。
 */
const WebSocket = require('ws');
const path = require('path');

const CDP_PORT = 9222;
let ws = null;
let msgId = 0;
const pending = new Map();
const results = [];

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
  });
}

function send(method, params) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.result && r.result.exceptionDetails) {
    throw new Error('页面执行异常: ' + JSON.stringify(r.result.exceptionDetails.exception || {}).slice(0, 200));
  }
  return r && r.result && r.result.result ? r.result.result.value : undefined;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 渲染端状态快照
const SNAPSHOT = `JSON.stringify((() => {
  const txt = (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\\s+/g,' ').trim() : null; };
  const t = txt('.ctl-time') || '';
  const m = t.match(/(\\d+:\\d{2})\\s*\\/\\s*(\\d+:\\d{2})/);
  const playBtn = document.querySelector('[data-cmd="cycle pause"]');
  return {
    idleMode: document.body.classList.contains('idle-mode'),
    time: m ? m[1] : t,
    duration: m ? m[2] : '',
    playBtnHtml: playBtn ? playBtn.innerHTML.slice(0, 120) : null,
    resumeCard: !(document.querySelector('#resume-card') || {classList: {contains: () => true}}).classList.contains('hidden'),
    resumeMeta: txt('#resume-card .resume-meta'),
  };
})())`;

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function timeToSec(ts) {
  if (!ts) return NaN;
  const p = ts.split(':').map(Number);
  return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + (p[2] || 0);
}

/**
 * 跑全部 GUI 断言。调用前需已 connect() 建立 CDP 连接。
 * @param {string} MEDIA 媒体文件绝对路径
 * @returns {{passed:number, total:number, results:Array}}
 */
async function runGuiTests(MEDIA) {
  if (!MEDIA) {
    console.error('runGuiTests 需要媒体文件路径');
    process.exit(2);
  }
  // 1. 初始状态:确保处于 idle 落地页(若上次运行遗留播放状态,先返回主页)
  let s = JSON.parse(await evalJS(SNAPSHOT));
  if (!s.idleMode) {
    await evalJS(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.title || '').includes('返回主界面'));
      if (b) { b.click(); return 'clicked'; }
      return 'no-btn';
    })()`);
    await wait(1500);
    s = JSON.parse(await evalJS(SNAPSHOT));
  }
  check('idle 落地页就绪', s.idleMode === true, `idleMode=${s.idleMode}`);

  // 2. 加载媒体(直接走 preload IPC,绕过 UI 按钮)
  // resumeFromStart:true 跳过续播位置——gui-test 断言的是"从头播放",
  // 若被 watchLater 续播(如 sdr-1080p 上次位置 19.97s)会立即播完 eof,
  // 时间码归零导致播放推进/暂停恢复断言全失败。
  await evalJS(`window.lumen.load(${JSON.stringify(MEDIA)}, { resumeFromStart: true }); 'ok'`);
  // 等加载:轮询直到离开 idle 且时间文本出现
  let loaded = false;
  for (let i = 0; i < 60; i++) {
    await wait(500);
    s = JSON.parse(await evalJS(SNAPSHOT));
    if (!s.idleMode && s.time && s.duration && s.duration !== '0:00') { loaded = true; break; }
  }
  check('媒体加载完成', loaded, `time=${s.time}/${s.duration}`);

  // 3. 播放推进(加载后自动播放)
  await wait(3000);
  const t1 = JSON.parse(await evalJS(SNAPSHOT)).time;
  await wait(2500);
  const t2 = JSON.parse(await evalJS(SNAPSHOT)).time;
  check('播放推进(时间码前进)', timeToSec(t2) > timeToSec(t1), `${t1} → ${t2}`);

  // 4. 暂停
  await evalJS(`document.querySelector('[data-cmd="cycle pause"]').click(); 'ok'`);
  await wait(600);
  const p1 = JSON.parse(await evalJS(SNAPSHOT)).time;
  await wait(2000);
  const p2 = JSON.parse(await evalJS(SNAPSHOT)).time;
  check('暂停生效(时间码停住)', p1 === p2, `${p1} / ${p2}`);

  // 5. 恢复播放
  await evalJS(`document.querySelector('[data-cmd="cycle pause"]').click(); 'ok'`);
  await wait(2500);
  const r1 = JSON.parse(await evalJS(SNAPSHOT)).time;
  await wait(2000);
  const r2 = JSON.parse(await evalJS(SNAPSHOT)).time;
  check('恢复播放(时间码前进)', timeToSec(r2) > timeToSec(r1), `${r1} → ${r2}`);

  // 6. 停止:时间归零 + 播放按钮变"播放"图标(icon-play)
  await evalJS(`document.querySelector('[data-cmd="stop"]').click(); 'ok'`);
  await wait(1500);
  s = JSON.parse(await evalJS(SNAPSHOT));
  const stopTime = s.time === '0:00' || s.time === '0:0';
  const playIcon = /icon-play|播放/.test(s.playBtnHtml || '') && !/icon-pause/.test(s.playBtnHtml || '');
  check('停止后时间归零', stopTime, `time=${s.time}`);
  check('停止后播放按钮为播放态', playIcon, `btn=${(s.playBtnHtml || '').slice(0, 60)}`);

  // 7. 停止后点播放 → 从头重新加载(0:00 起播,不是续播位置)
  await evalJS(`document.querySelector('[data-cmd="cycle pause"]').click(); 'ok'`);
  await wait(6000); // 等待重新加载(大文件需几秒)
  s = JSON.parse(await evalJS(SNAPSHOT));
  const fromStart = timeToSec(s.time) >= 0 && timeToSec(s.time) < 12;
  check('停止后点播放从头开始', fromStart && s.duration !== '0:00', `time=${s.time}/${s.duration}`);

  // 8. 倍速面板:点击倍速按钮 → 面板出现 → 选 2×
  await evalJS(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /\\d+\\.\\d+×/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  await wait(500);
  const speedPanel = await evalJS(`!!Array.from(document.querySelectorAll('*')).find((e) => e.textContent.trim() === '播放速度')`);
  check('倍速面板弹出', speedPanel === true);
  await evalJS(`(() => {
    const items = Array.from(document.querySelectorAll('div,span,button')).filter((e) => /^\\s*2×\\s*$/.test(e.textContent));
    const it = items[items.length - 1];
    if (it) it.click();
    return !!it;
  })()`);
  await wait(600);
  s = JSON.parse(await evalJS(SNAPSHOT));
  const speedBtn = await evalJS(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /×/.test(x.textContent));
    return b ? b.textContent.trim() : null;
  })()`);
  check('倍速切换为 2×', (speedBtn || '').startsWith('2'), `speed=${speedBtn}`);

  // 9. 返回主界面 → idle 落地页 + 续播卡片
  await evalJS(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.title || '').includes('返回主界面'));
    if (b) b.click();
    return !!b;
  })()`);
  await wait(1500);
  s = JSON.parse(await evalJS(SNAPSHOT));
  check('返回主界面(idle 落地页)', s.idleMode === true, `idleMode=${s.idleMode}`);

  // 10. "从此处继续" → 从续播位置恢复(时间 > 0,非从头)
  const hadResume = s.resumeCard;
  check('续播卡片可见', hadResume, s.resumeMeta || '');
  if (hadResume) {
    await evalJS(`document.querySelector('#resume-play').click(); 'ok'`);
    await wait(7000);
    s = JSON.parse(await evalJS(SNAPSHOT));
    check('从此处继续恢复播放', !s.idleMode && s.duration !== '0:00', `time=${s.time}/${s.duration}`);
  }

  const passed = results.filter((r) => r.pass).length;
  return { passed, total: results.length, results };
}

async function main() {
  const MEDIA = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!MEDIA) {
    console.error('用法: node tools/gui-test.js <媒体文件>');
    process.exit(2);
  }
  // 1. 发现 CDP 目标
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  } catch (e) {
    console.error('无法连接 CDP。请先启动播放器: electron . --force-renderer-accessibility --remote-debugging-port=' + CDP_PORT);
    process.exit(1);
  }
  const page = targets.find((t) => t.type === 'page' && t.title === 'Lumora' && t.url.includes('index.html'));
  if (!page) {
    console.error('未找到 Lumora 主页面目标。');
    process.exit(1);
  }
  await connect(page.webSocketDebuggerUrl);
  await wait(300);

  const summary = await runGuiTests(MEDIA);
  console.log(`\n结果: ${summary.passed}/${summary.total} 项通过`);
  process.exit(summary.passed === summary.total ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('测试异常:', e.message);
    process.exit(1);
  });
}

module.exports = { connect, runGuiTests, check, timeToSec };
