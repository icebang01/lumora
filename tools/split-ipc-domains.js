// Lumora register-ipc.js 按领域拆分：player / media / window / app 四个域模块 + 编排器
// 原理：registerIpc 函数体里的 handler 已全是 getXxx() 访问器形式，拆分只需
// 按 ipcMain.handle/on 块路由到域模块，每个域模块自带所需的访问器与 require。
const fs = require('fs');
const SRC = 'src/main/register-ipc.js';

fs.copyFileSync(SRC, 'src/main/register-ipc.js.orig'); // 备份，可恢复

const text = fs.readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

// ---- 定位 registerIpc 函数体 ----
const startIdx = lines.findIndex((l) => /^function registerIpc\(\) \{/.test(l));
if (startIdx === -1) throw new Error('找不到 function registerIpc() {');
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i] === '}') { endIdx = i; break; }
}
if (endIdx === -1) throw new Error('找不到 registerIpc 结束括号');
const bodyLines = lines.slice(startIdx + 1, endIdx);
console.log(`registerIpc 体: 行 ${startIdx + 2}-${endIdx} (${bodyLines.length} 行)`);

// ---- 代码区掩码（跳过字符串/模板/注释，用于括号配平） ----
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

// ---- 按 handler 切块 ----
// 返回 [{ channel, lines: [startIdx, endIdx] (闭区间, 0 基相对 body), preamble: [行] }]
const bodyText = bodyLines.join('\r\n');
const fullMask = codeMask(bodyText);
const lineOffset = [0];
for (let j = 0; j < bodyLines.length; j++) {
  lineOffset.push(lineOffset[j] + bodyLines[j].length + 2); // + \r\n
}

const blocks = [];
let cur = null; // { channel, lines: [] }
for (let i = 0; i < bodyLines.length; i++) {
  const line = bodyLines[i];
  const m = line.match(/^\s*ipcMain\.(?:handle|on)\('([^']+)'/);
  if (m) {
    if (cur) blocks.push(cur);
    cur = { channel: m[1], start: i, end: i };
    // 配平找块尾（整段 body 的 mask + 行偏移）
    let depth = 0;
    for (let j = i; j < bodyLines.length; j++) {
      const l = bodyLines[j];
      for (let k = 0; k < l.length; k++) {
        if (!fullMask[lineOffset[j] + k]) continue;
        const ch = l[k];
        if (ch === '(' || ch === '{') depth++;
        else if (ch === ')' || ch === '}') depth--;
      }
      if (depth <= 0) { cur.end = j; break; }
    }
  } else if (cur) {
    // 继续当前块
  }
}
if (cur) blocks.push(cur);
console.log(`切出 ${blocks.length} 个 handler 块`);

// 块间行（注释/空行/pipDragBase 等）归入下一个块的 preamble
const routed = [];
let lastEnd = -1;
for (const b of blocks) {
  const preamble = bodyLines.slice(lastEnd + 1, b.start);
  routed.push({ ...b, preamble });
  lastEnd = b.end;
}
// 块尾残留（函数体最后一段，如 player:dropped 之后）→ 并入最后一块
const tail = bodyLines.slice(lastEnd + 1);
if (tail.length) routed[routed.length - 1].tail = tail;

// ---- 路由表 ----
function routeOf(channel) {
  if (channel.startsWith('player:') || channel.startsWith('mpv:')) return 'player';
  if (channel === 'app:bootstrap' || channel.startsWith('config:') || channel.startsWith('scripts:')) return 'app';
  if (channel.startsWith('subtitles:') || channel.startsWith('danmaku:') ||
      channel.startsWith('app:') || channel.startsWith('playlist:')) return 'media';
  if (channel.startsWith('ui:') || channel.startsWith('window:') || channel.startsWith('pip:')) return 'window';
  throw new Error('无法路由: ' + channel);
}

const domains = { player: [], media: [], window: [], app: [] };
for (const b of routed) {
  domains[routeOf(b.channel)].push(b);
}
for (const [d, bs] of Object.entries(domains)) {
  console.log(`  ${d}: ${bs.map((b) => b.channel).join(', ')}`);
}

// ---- 每个域需要的访问器（扫描块内出现的已知访问器名） ----
const ACCESSORS = [
  'getConfig', 'getWin', 'getVideoWin', 'getCurrentInfo', 'getUseMpv', 'getMpvBackend',
  'getPipeline', 'getLastKnownTime', 'setLastKnownTime', 'getIdleState', 'setIdleState',
  'getMediaServer', 'getFfmpegCaps', 'getPendingOpenFile', 'sendToRenderer',
  'writePlayerConfKey', 'formatTimeForFilename',
];
const ACCESSOR_DEFS = {
  getConfig: 'return CTX.getConfig ? CTX.getConfig() : null;',
  getWin: 'return CTX.getWin ? CTX.getWin() : null;',
  getVideoWin: 'return CTX.getVideoWin ? CTX.getVideoWin() : null;',
  getCurrentInfo: 'return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null;',
  getUseMpv: 'return CTX.getUseMpv ? CTX.getUseMpv() : true;',
  getMpvBackend: 'return CTX.getMpvBackend ? CTX.getMpvBackend() : null;',
  getPipeline: 'return CTX.getPipeline ? CTX.getPipeline() : null;',
  getLastKnownTime: 'return CTX.getLastKnownTime ? CTX.getLastKnownTime() : 0;',
  setLastKnownTime: 'if (CTX.setLastKnownTime) CTX.setLastKnownTime(v);',
  getIdleState: 'return CTX.getIdleState ? CTX.getIdleState() : true;',
  setIdleState: 'if (CTX.setIdleState) CTX.setIdleState(v);',
  getMediaServer: 'return CTX.getMediaServer ? CTX.getMediaServer() : null;',
  getFfmpegCaps: 'return CTX.getFfmpegCaps ? CTX.getFfmpegCaps() : null;',
  getPendingOpenFile: 'return CTX.getPendingOpenFile ? CTX.getPendingOpenFile() : null;',
  sendToRenderer: 'if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload);',
  writePlayerConfKey: 'if (CTX.writePlayerConfKey) CTX.writePlayerConfKey(k, v);',
  formatTimeForFilename: 'return CTX.formatTimeForFilename ? CTX.formatTimeForFilename(t) : String(t);',
};

function usedAccessors(blocks) {
  const used = new Set();
  for (const b of blocks) {
    const joined = [...b.preamble, ...bodyLines.slice(b.start, b.end + 1), ...(b.tail || [])].join('\n');
    for (const a of ACCESSORS) {
      if (new RegExp('\\b' + a + '\\s*\\(').test(joined)) used.add(a);
    }
  }
  return [...used];
}
function accessorBlock(used) {
  return used.map((a) => {
    const params = (a.startsWith('set') || a === 'writePlayerConfKey') ? '(v)' : (a === 'formatTimeForFilename' ? '(t)' : (a === 'sendToRenderer' ? '(channel, payload)' : '()'));
    return `function ${a}${params} { ${ACCESSOR_DEFS[a]} }`;
  }).join('\n');
}

// ---- 各域头部 require ----
const HEADS = {
  player: `const { ipcMain, dialog, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadFile } = require('./play-control');
const { collectMediaFromSelection } = require('./file-assoc');
const { extractAndSendSubtitles } = require('./media-auto');`,
  media: `const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadResume, clearResume } = require('./resume-store');
const { loadPlaylist, savePlaylist, clearPlaylist } = require('./playlist-store');
const { loadHistory, clearHistory, removeHistory } = require('./history-store');
const { generate: generateThumbnail } = require('./ffmpeg/thumbnail');
const { extractCoverArt } = require('./ffmpeg/cover-art');
const { loadLyrics } = require('./ffmpeg/lyrics');
const Subtitles = require('./subtitles');
const Danmaku = require('./danmaku');`,
  window: `const { ipcMain } = require('electron');
const pip = require('./pip');
const { togglePip, syncPipControlWin, updatePipControlState } = pip;
const { setFullscreen, resyncNow, ensureVideoWindow } = require('./windows');`,
  app: `const { ipcMain, shell, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULTS, parseInputConf } = require('./config');
const { DEFAULT_KEYBINDS } = require('../shared/default-keybinds');
const { applyFileAssociation } = require('./file-assoc');
const { loadResume } = require('./resume-store');
const { loadPlaylist } = require('./playlist-store');
const Subtitles = require('./subtitles');
const Danmaku = require('./danmaku');`,
};
const DOMAIN_TITLE = {
  player: '播放控制域：player:*（载入/seek/速度/轨道/hwdec/停止）+ mpv 直通 + 截图',
  media: '内容域：subtitles:* + danmaku:* + app:*（续播/历史/缩略图/封面/歌词）+ playlist:*',
  window: '窗口域：ui:set-idle-state + window:command + pip:*（拖动/缩放/按钮）',
  app: '应用配置域：app:bootstrap + config:*（含键位编辑）+ scripts:list',
};

for (const [domain, blocks] of Object.entries(domains)) {
  const used = usedAccessors(blocks);
  const parts = [];
  for (const b of blocks) {
    if (b.preamble && b.preamble.length) parts.push(b.preamble.join('\r\n'));
    parts.push(bodyLines.slice(b.start, b.end + 1).join('\r\n'));
    if (b.tail && b.tail.length) parts.push(b.tail.join('\r\n'));
  }
  const body = parts.join('\r\n\r\n');
  const accessorSrc = used.length ? '\n' + accessorBlock(used) + '\n' : '';
  const out = `/**
 * IPC 注册·${domain}（自包含模块）。
 * 从 register-ipc.js 拆出（2026-08）：${DOMAIN_TITLE[domain]}。
 * 用法：register(ctx)——ctx 与 register-ipc.js 的 setCtx 同构（getConfig/getCurrentInfo/...），
 * 由 register-ipc.js 编排器统一注入。
 */
${HEADS[domain]}
let CTX = {};
function register(ipcCtx) { CTX = ipcCtx || {};${accessorSrc}
${body}
}

module.exports = { register };
`;
  fs.writeFileSync(`src/main/ipc-${domain}.js`, out);
  console.log(`ipc-${domain}.js 已写入 (${used.length} 个访问器)`);
}

// ---- 重写 register-ipc.js 为编排器 ----
const orchestrator = `/**
 * IPC 注册（编排器，自包含模块）。
 * 2026-08 按领域拆分：ipc-player / ipc-media / ipc-window / ipc-app。
 * 用法：setCtx({...}) 注入宿主状态（见各 ipc-*.js 的访问器），再 registerIpc()。
 */
const playerIpc = require('./ipc-player');
const mediaIpc = require('./ipc-media');
const windowIpc = require('./ipc-window');
const appIpc = require('./ipc-app');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }

function registerIpc() {
  playerIpc.register(CTX);
  mediaIpc.register(CTX);
  windowIpc.register(CTX);
  appIpc.register(CTX);
}

module.exports = { setCtx, registerIpc };
`;
fs.writeFileSync(SRC, orchestrator);
console.log('register-ipc.js 已重写为编排器');
