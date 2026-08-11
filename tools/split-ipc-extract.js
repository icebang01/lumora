// Lumora index.js 拆分：registerIpc 整体迁出到 register-ipc.js（带断言的手术脚本）
// 变换原则：词法器标记代码区/字符串/注释，替换只作用于代码区（字符串里的 'config:set' 等绝不误伤）。
const fs = require('fs');
const INDEX = 'src/main/index.js';

const lines = fs.readFileSync(INDEX, 'utf8').split(/\r?\n/);

// ---- 定位 registerIpc 函数体 ----
const startIdx = lines.findIndex((l) => /^function registerIpc\(\) \{/.test(l));
if (startIdx === -1) throw new Error('找不到 function registerIpc() {');
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i] === '}') { endIdx = i; break; }
}
if (endIdx === -1) throw new Error('找不到 registerIpc 结束括号');
console.log(`registerIpc: 行 ${startIdx + 1}-${endIdx + 1} (${endIdx - startIdx + 1} 行)`);

const body = lines.slice(startIdx + 1, endIdx).join('\r\n'); // 函数体（不含花括号行）

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

// ---- 单遍替换：仅代码区 ----
const COMBINED = /(lastKnownTime\s*=\s*time;|idleState\s*=\s*!!idle;|\blastKnownTime\b|\bidleState\b|\bcurrentInfo\b|\bmediaServer\b|\bffmpegCaps\b|\bpendingOpenFile\b|\buseMpv\b|\bmpvBackend\b|\bpipeline\b|\bvideoWin\b|\bwin\b|\bconfig\b)/g;
const REPL = {
  'lastKnownTime = time;': 'setLastKnownTime(time);',
  'idleState = !!idle;': 'setIdleState(!!idle);',
  lastKnownTime: 'getLastKnownTime()',
  idleState: 'getIdleState()',
  currentInfo: 'getCurrentInfo()',
  mediaServer: 'getMediaServer()',
  ffmpegCaps: 'getFfmpegCaps()',
  pendingOpenFile: 'getPendingOpenFile()',
  useMpv: 'getUseMpv()',
  mpvBackend: 'getMpvBackend()',
  pipeline: 'getPipeline()',
  videoWin: 'getVideoWin()',
  win: 'getWin()',
  config: 'getConfig()',
};

function transform(src) {
  const mask = codeMask(src);
  let out = '';
  let last = 0;
  COMBINED.lastIndex = 0;
  let m;
  let count = 0;
  while ((m = COMBINED.exec(src)) !== null) {
    const s = m.index, e = m.index + m[0].length;
    let ok = true;
    for (let k = s; k < e; k++) if (!mask[k]) { ok = false; break; }
    if (ok) {
      out += src.slice(last, s) + REPL[m[0]];
      last = e;
      count++;
    }
  }
  out += src.slice(last);
  return { out, count };
}

const { out: bodyT, count: replCount } = transform(body);
console.log(`代码区替换 ${replCount} 处`);

// 断言：变换后代码区不应再有裸标识符
{
  const mask2 = codeMask(bodyT);
  const leftover = [];
  for (const name of Object.keys(REPL)) {
    const re = new RegExp('\\b' + name.replace(/\s+/g, '\\s+').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    let mm;
    while ((mm = re.exec(bodyT)) !== null) {
      const s = mm.index, e = mm.index + mm[0].length;
      let ok = true;
      for (let k = s; k < e; k++) if (!mask2[k]) { ok = false; break; }
      if (ok) { leftover.push(name); break; }
    }
  }
  if (leftover.length) throw new Error('仍有裸标识符未替换: ' + [...new Set(leftover)].join(', '));
  console.log('裸标识符断言通过');
}

// ---- 组装 register-ipc.js ----
const header = `/**
 * IPC 注册（自包含模块）。
 * 从 index.js 拆出（2026-08）：registerIpc 全部 ipcMain 处理器
 * （app/player/subtitles/danmaku/mpv/ui/window/pip/config/scripts/playlist 各领域）。
 * 用法：setCtx({...}) 注入宿主状态与工具函数（config/mediaServer/mpvBackend/win/
 * videoWin 等 + writePlayerConfKey/formatTimeForFilename/sendToRenderer），再 registerIpc()。
 * 模块依赖（play-control/pip/windows/各 store/ffmpeg 工具）直接 require，无循环。
 */
const { ipcMain, dialog, app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { DEFAULTS, parseInputConf } = require('./config');
const { DEFAULT_KEYBINDS } = require('../shared/default-keybinds');
const { loadResume, clearResume } = require('./resume-store');
const { loadPlaylist, savePlaylist, clearPlaylist } = require('./playlist-store');
const { loadHistory, clearHistory, removeHistory } = require('./history-store');
const { loadFile } = require('./play-control');
const { collectMediaFromSelection, applyFileAssociation } = require('./file-assoc');
const { extractAndSendSubtitles } = require('./media-auto');
const pip = require('./pip');
const { togglePip, syncPipControlWin, updatePipControlState } = pip;
const { setFullscreen, resyncNow, ensureVideoWindow } = require('./windows');
const Subtitles = require('./subtitles');
const Danmaku = require('./danmaku');
const { generate: generateThumbnail } = require('./ffmpeg/thumbnail');
const { extractCoverArt } = require('./ffmpeg/cover-art');
const { loadLyrics } = require('./ffmpeg/lyrics');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getMediaServer() { return CTX.getMediaServer ? CTX.getMediaServer() : null; }
function getFfmpegCaps() { return CTX.getFfmpegCaps ? CTX.getFfmpegCaps() : null; }
function getPendingOpenFile() { return CTX.getPendingOpenFile ? CTX.getPendingOpenFile() : null; }
function getCurrentInfo() { return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null; }
function getUseMpv() { return CTX.getUseMpv ? CTX.getUseMpv() : true; }
function getMpvBackend() { return CTX.getMpvBackend ? CTX.getMpvBackend() : null; }
function getPipeline() { return CTX.getPipeline ? CTX.getPipeline() : null; }
function getLastKnownTime() { return CTX.getLastKnownTime ? CTX.getLastKnownTime() : 0; }
function setLastKnownTime(v) { if (CTX.setLastKnownTime) CTX.setLastKnownTime(v); }
function getIdleState() { return CTX.getIdleState ? CTX.getIdleState() : true; }
function setIdleState(v) { if (CTX.setIdleState) CTX.setIdleState(v); }
function getWin() { return CTX.getWin ? CTX.getWin() : null; }
function getVideoWin() { return CTX.getVideoWin ? CTX.getVideoWin() : null; }
function sendToRenderer(channel, payload) { if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload); }
function writePlayerConfKey(k, v) { if (CTX.writePlayerConfKey) CTX.writePlayerConfKey(k, v); }
function formatTimeForFilename(t) { return CTX.formatTimeForFilename ? CTX.formatTimeForFilename(t) : String(t); }

function registerIpc() {
`;

const footer = `}

module.exports = { setCtx, registerIpc };
`;

fs.writeFileSync('src/main/register-ipc.js', header + bodyT + '\r\n' + footer);
console.log('register-ipc.js 已写入');

// ---- index.js：删除函数体 ----
const newLines = [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];
let idx = newLines.join('\r\n');

// 插入 require（windows require 之后）
const winReq = "const { createWindow, resyncNow, setFullscreen, ensureVideoWindow } = windows;";
if (!idx.includes(winReq)) throw new Error('找不到 windows require 锚点');
idx = idx.replace(winReq, winReq + "\r\nconst ipc = require('./register-ipc');");

// 替换调用点
const callOld = '  registerIpc();';
if (!idx.includes(callOld)) throw new Error('找不到 registerIpc() 调用点');
const callNew = `  ipc.setCtx({
    getConfig: () => config,
    getMediaServer: () => mediaServer,
    getFfmpegCaps: () => ffmpegCaps,
    getPendingOpenFile: () => pendingOpenFile,
    getCurrentInfo: () => currentInfo,
    getUseMpv: () => useMpv,
    getMpvBackend: () => mpvBackend,
    getPipeline: () => pipeline,
    getLastKnownTime: () => lastKnownTime,
    setLastKnownTime: (v) => { lastKnownTime = v; },
    getIdleState: () => idleState,
    setIdleState: (v) => { idleState = v; },
    getWin: () => win,
    getVideoWin: () => videoWin,
    sendToRenderer,
    writePlayerConfKey,
    formatTimeForFilename,
  });
  ipc.registerIpc();`;
idx = idx.replace(callOld, callNew);

fs.writeFileSync(INDEX, idx);
console.log('index.js 手术完成');
