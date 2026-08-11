// Lumora renderer/app.js 拆分：exposeDiagnostics+setupDebug → app-diagnostics.js；bindMainEvents → app-events.js
const fs = require('fs');
const APP = 'src/renderer/app.js';
const lines = fs.readFileSync(APP, 'utf8').split(/\r?\n/);

function assertLine(idx1, re, label) {
  if (!lines[idx1 - 1] || !re.test(lines[idx1 - 1])) {
    throw new Error(`断言失败 ${label}: 第${idx1}行=${JSON.stringify(lines[idx1 - 1])}`);
  }
}
// 动态找函数结束：从 startIdx（1 基）向后找第一个 ^}$ 行
function findEnd(startIdx1) {
  for (let i = startIdx1; i <= lines.length; i++) {
    if (lines[i - 1] === '}') return i;
  }
  throw new Error(`找不到 ${startIdx1} 之后的结束括号`);
}
assertLine(281, /^\/\*\*$/, 'exposeDiagnostics doc 起点');
assertLine(288, /^function exposeDiagnostics/, 'exposeDiagnostics');
const diagEnd = findEnd(288);
assertLine(642, /^\/\* =/, '主进程事件 header');
assertLine(646, /^function bindMainEvents/, 'bindMainEvents');
const evEnd = findEnd(646);
assertLine(742, /^\/\*\*$/, 'setupDebug doc 起点');
assertLine(747, /^function setupDebug/, 'setupDebug');
const dbgEnd = findEnd(747);
console.log(`exposeDiagnostics 281-${diagEnd}, bindMainEvents 642-${evEnd}, setupDebug 742-${dbgEnd}`);

// 提取三段
const diagSec = lines.slice(280, diagEnd).join('\r\n');   // 281-diagEnd
const eventsSec = lines.slice(641, evEnd).join('\r\n');   // 642-evEnd
const debugSec = lines.slice(741, dbgEnd).join('\r\n');   // 742-dbgEnd

// ---- 代码区掩码 ----
function codeMask(src) {
  const mask = new Array(src.length).fill(true);
  let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { mask[i] = false; i++; }
    } else if (c === '/' && c2 === '*') {
      mask[i] = false; if (i + 1 < n) mask[i + 1] = false; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { mask[i] = false; i++; }
      if (i < n) { mask[i] = false; if (i + 1 < n) mask[i + 1] = false; i += 2; }
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c; mask[i] = false; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { if (i < n) mask[i] = false; i++; if (i < n) { mask[i] = false; i++; } continue; }
        mask[i] = false; i++;
      }
      if (i < n) { mask[i] = false; i++; }
    } else i++;
  }
  return mask;
}

function transform(src, combined, repl) {
  const mask = codeMask(src);
  let out = '';
  let last = 0;
  combined.lastIndex = 0;
  let m;
  let count = 0;
  while ((m = combined.exec(src)) !== null) {
    const s = m.index, e = m.index + m[0].length;
    let ok = true;
    for (let k = s; k < e; k++) if (!mask[k]) { ok = false; break; }
    if (ok) {
      out += src.slice(last, s) + repl(m[0]);
      last = e;
      count++;
    }
  }
  out += src.slice(last);
  return { out, count };
}

function assertNoBare(src, names, label) {
  const mask = codeMask(src);
  for (const name of names) {
    const re = new RegExp('\\b' + name + '\\b', 'g');
    let mm;
    while ((mm = re.exec(src)) !== null) {
      let ok = true;
      for (let k = mm.index; k < mm.index + mm[0].length; k++) if (!mask[k]) { ok = false; break; }
      if (!ok) continue;
      // 属性访问 xxx.ready 或 属性键 ready: 不是变量引用，跳过
      const before = src[mm.index - 1];
      const after = src[mm.index + mm[0].length];
      if (before === '.' || after === ':') continue;
      throw new Error(`${label} 裸标识符残留: ${name}`);
    }
  }
}

// ---- app-diagnostics 段（exposeDiagnostics）----
// 注意：ready/playlist/keybinds/scripts 在快照对象里同时是"属性键"（ready: / playlist: {）
// 与"变量读"（playlist.length），通用词替换会误伤键——先精确处理含键的行，再处理变量读。
const DIAG_RE = /(^\s*ready,\r?$|keybinds:\s*keybinds\.binds\.length|scripts:\s*scripts\.scripts\.map|playlist:\s*\{[^}]*?count:\s*playlist\.length|\bplaylistIndex\b|\bplaylist\b|\bkeybinds\b|\bscripts\b|\bosd\b)/gm;
function diagRepl(tok) {
  if (tok.trim() === 'ready,') return tok.replace(/ready,/, 'ready: getReady(),'); // 保留前导缩进
  if (tok.includes('keybinds:')) return tok.replace(/keybinds\.binds\.length/, 'getKeybinds().binds.length');
  if (tok.includes('scripts:')) return tok.replace(/scripts\.scripts\.map/, 'getScripts().scripts.map');
  if (tok.includes('playlist:')) return tok.replace(/count:\s*playlist\.length/, 'count: getPlaylist().length');
  if (tok === 'playlistIndex') return 'getPlaylistIndex()';
  if (tok === 'playlist') return 'getPlaylist()';
  if (tok === 'keybinds') return 'getKeybinds()';
  if (tok === 'scripts') return 'getScripts()';
  return 'getOsd()';
}
const { out: diagT, count: diagC } = transform(diagSec, DIAG_RE, diagRepl);
assertNoBare(diagT, ['ready', 'playlistIndex', 'playlist', 'keybinds', 'scripts', 'osd'], 'diagnostics');
console.log(`diagnostics 替换 ${diagC} 处`);

// ---- app-events 段（bindMainEvents）----
const EV_RE = /(playlistIndex\s*=\s*playlist\.indexOf\(payload\.info\.path\);|\bplaylistIndex\b|\bplaylist\b|\bready\b|\bwarnNoVideoOutput\b|\bdanmakuRenderer\b|\bpersistPlaylist\b|\bsetPlaylist\b|\brunCommand\b|\bload\b)/g;
function evRepl(tok) {
  if (tok.includes('playlistIndex = playlist.indexOf')) return 'setPlaylistIndex(playlist.indexOf(payload.info.path));';
  if (tok === 'playlistIndex') return 'getPlaylistIndex()';
  if (tok === 'ready') return 'getReady()';
  if (tok === 'danmakuRenderer') return 'getDanmakuRenderer()';
  // playlist/函数名保留：模块内定义 Proxy 或 ctx 访问器
  return tok;
}
const { out: evT, count: evC } = transform(eventsSec, EV_RE, evRepl);
assertNoBare(evT, ['playlistIndex', 'ready', 'danmakuRenderer'], 'events');
console.log(`events 替换 ${evC} 处`);

// ---- setupDebug 段（原样，只 player→proxy 名保留）----
const { out: debugT, count: debugC } = transform(debugSec, /\bplayer\b/g, () => 'player');
console.log(`setupDebug 替换 ${debugC} 处`);

// ---- 组装 app-diagnostics.js ----
const diagHeader = `/**
 * 渲染端诊断（自包含模块）。
 * 从 app.js 拆出（2026-08）：exposeDiagnostics（window.__lumen 快照/探针）+ setupDebug（调试 HUD）。
 * 用法：setupDiagnostics(ctx)（boot 末尾、一切就绪后注入；动态值用 getter）。
 */
let CTX = {};
export function setupDiagnostics(ctx) { CTX = ctx || {}; }

// player 全转发代理（方法自动 bind，属性直读）
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
function runCommand(args) { return CTX.runCommand ? CTX.runCommand(args) : null; }
function getReady() { return CTX.getReady ? CTX.getReady() : true; }
function getKeybinds() { return CTX.getKeybinds ? CTX.getKeybinds() : null; }
function getScripts() { return CTX.getScripts ? CTX.getScripts() : null; }
function getOsd() { return CTX.getOsd ? CTX.getOsd() : null; }
function getPlaylist() { return CTX.getPlaylist ? CTX.getPlaylist() : []; }
function getPlaylistIndex() { return CTX.getPlaylistIndex ? CTX.getPlaylistIndex() : -1; }

`;
const diagFooter = `
export { exposeDiagnostics, setupDebug };
`;
fs.writeFileSync('src/renderer/app-diagnostics.js', diagHeader + diagT + '\r\n' + debugT + '\r\n' + diagFooter);
console.log('app-diagnostics.js 已写入');

// ---- 组装 app-events.js ----
const evHeader = `/**
 * 主进程事件绑定（自包含模块）。
 * 从 app.js 拆出（2026-08）：bindMainEvents（window.lumen.on 全部分发 + 音频不可用提示）。
 * 用法：setupMainEvents(ctx)（boot 中 player 就绪后注入；playlist/playlistIndex 走 getter/setter
 * 保持实时——setPlaylist 会整体替换数组引用，不能存旧引用）。
 */
import { showLoadingScreen, endFirstFrameWait } from './panels/idle.js';
import { renderPlaylist } from './panels/playlist.js';
import { applyDanmakuDisplay } from './panels/danmaku.js';

const $ = (id) => document.getElementById(id);

let CTX = {};
export function setupMainEvents(ctx) { CTX = ctx || {}; }

// player/osd 全转发代理（方法自动 bind，属性直读）
const player = new Proxy({}, {
  get(_, k) {
    const p = CTX.player;
    if (!p) return undefined;
    return typeof p[k] === 'function' ? p[k].bind(p) : p[k];
  },
});
const osd = { message: (...a) => CTX.osd && CTX.osd.message(...a) };
// playlist 数组代理：每次取最新引用（setPlaylist 会整体替换数组）
const playlist = new Proxy([], {
  get(_, k) {
    const arr = CTX.getPlaylist ? CTX.getPlaylist() : [];
    if (!arr) return undefined;
    const v = arr[k];
    return typeof v === 'function' ? v.bind(arr) : v;
  },
});
function getReady() { return CTX.getReady ? CTX.getReady() : true; }
function getPlaylistIndex() { return CTX.getPlaylistIndex ? CTX.getPlaylistIndex() : -1; }
function setPlaylistIndex(v) { if (CTX.setPlaylistIndex) CTX.setPlaylistIndex(v); }
function getDanmakuRenderer() { return CTX.getDanmakuRenderer ? CTX.getDanmakuRenderer() : null; }
function setPlaylist(paths, index) { if (CTX.setPlaylist) CTX.setPlaylist(paths, index); }
function persistPlaylist() { if (CTX.persistPlaylist) CTX.persistPlaylist(); }
function load(filePath) { return CTX.load ? CTX.load(filePath) : null; }
function runCommand(args) { return CTX.runCommand ? CTX.runCommand(args) : null; }
function warnNoVideoOutput(reason) { if (CTX.warnNoVideoOutput) CTX.warnNoVideoOutput(reason); }

`;
const evFooter = `
export { bindMainEvents };
`;
fs.writeFileSync('src/renderer/app-events.js', evHeader + evT + '\r\n' + evFooter);
console.log('app-events.js 已写入');

// ---- app.js：删除三段（自底向上）----
const removals = [
  { a: 742, b: dbgEnd, probe: /^\/\*\*$/, label: 'setupDebug' },
  { a: 642, b: evEnd, probe: /^\/\* =/, label: 'bindMainEvents 段' },
  { a: 281, b: diagEnd, probe: /^\/\*\*$/, label: 'exposeDiagnostics 段' },
];
// 先断言全部（基于原始行号）
for (const r of removals) {
  if (!lines[r.a - 1] || !r.probe.test(lines[r.a - 1])) throw new Error(`起点不符 ${r.label}: ${JSON.stringify(lines[r.a - 1])}`);
}
const work = [...lines];
for (const r of removals) {
  const removed = work.splice(r.a - 1, r.b - r.a + 1);
  console.log(`  删 [${r.a}-${r.b}] ${r.label} (${removed.length} 行)`);
}
let src = work.join('\r\n');

// 导入两个新模块（插在 input.js import 之后）
const inAnchor = "import { setupInput, bindInput, bindDragDrop, bindAudioUnlock, bindClickToFront } from './input.js';";
if (!src.includes(inAnchor)) throw new Error('找不到 input.js import 锚点');
src = src.replace(inAnchor, inAnchor + "\r\n" +
  "import { setupDiagnostics, exposeDiagnostics, setupDebug } from './app-diagnostics.js';\r\n" +
  "import { setupMainEvents, bindMainEvents } from './app-events.js';");

// boot：注入 ctx
const evCall = '  bindMainEvents();';
if (!src.includes(evCall)) throw new Error('找不到 bindMainEvents() 调用');
src = src.replace(evCall, '  setupMainEvents({\r\n' +
  '    player, osd,\r\n' +
  '    getPlaylist: () => playlist,\r\n' +
  '    getReady: () => ready,\r\n' +
  '    getPlaylistIndex: () => playlistIndex,\r\n' +
  '    setPlaylistIndex: (v) => { playlistIndex = v; },\r\n' +
  '    getDanmakuRenderer: () => danmakuRenderer,\r\n' +
  '    setPlaylist, persistPlaylist, load, runCommand, warnNoVideoOutput,\r\n' +
  '  });\r\n' + evCall);

const diagCall = '  setupDebug();';
if (!src.includes(diagCall)) throw new Error('找不到 setupDebug() 调用');
src = src.replace(diagCall, '  setupDiagnostics({\r\n' +
  '    player, osd, keybinds, scripts, runCommand,\r\n' +
  '    getReady: () => ready,\r\n' +
  '    getPlaylist: () => playlist,\r\n' +
  '    getPlaylistIndex: () => playlistIndex,\r\n' +
  '  });\r\n' + diagCall);

fs.writeFileSync(APP, src);
console.log('app.js 手术完成');
