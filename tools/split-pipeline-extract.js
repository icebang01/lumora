// Lumora index.js 拆分：setupPipeline 迁出到 media-pipeline.js（ffmpeg 引擎解码编排）
const fs = require('fs');
const INDEX = 'src/main/index.js';
const lines = fs.readFileSync(INDEX, 'utf8').split(/\r?\n/);

// ---- 定位：解码编排小节头 → setupPipeline 函数结束 ----
const secStart = lines.findIndex((l) => l.includes('/* 解码编排'));
if (secStart === -1) throw new Error('找不到解码编排小节');
const fnStart = lines.findIndex((l, i) => i >= secStart && /^function setupPipeline\(\) \{/.test(l));
if (fnStart === -1) throw new Error('找不到 setupPipeline');
let fnEnd = -1;
for (let i = fnStart + 1; i < lines.length; i++) {
  if (lines[i] === '}') { fnEnd = i; break; }
}
if (fnEnd === -1) throw new Error('找不到 setupPipeline 结束');
console.log(`解码编排段: 行 ${secStart + 1}-${fnEnd + 1} (${fnEnd - secStart + 1} 行)`);

const section = lines.slice(secStart, fnEnd + 1).join('\r\n');

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

// ---- 单遍替换 ----
const COMBINED = /(pipeline\s*=\s*new\s+MediaPipeline\(|\bpipeline\b|\bmediaServer\b|\bconfig\b|\blastKnownTime\b|\bcurrentInfo\b)/g;
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
      let rep;
      if (m[0].includes('= new MediaPipeline(')) rep = 'setPipeline(new MediaPipeline(';
      else if (m[0] === 'pipeline') rep = 'getPipeline()';
      else if (m[0] === 'mediaServer') rep = 'getMediaServer()';
      else if (m[0] === 'config') rep = 'getConfig()';
      else if (m[0] === 'lastKnownTime') rep = 'getLastKnownTime()';
      else rep = 'getCurrentInfo()';
      out += src.slice(last, s) + rep;
      last = e;
      count++;
    }
  }
  out += src.slice(last);
  return { out, count };
}

const { out: secT, count } = transform(section);
console.log(`代码区替换 ${count} 处`);

// 断言无裸标识符（代码区）
{
  const mask2 = codeMask(secT);
  for (const name of ['pipeline', 'mediaServer', 'config', 'lastKnownTime', 'currentInfo']) {
    const re = new RegExp('\\b' + name + '\\b', 'g');
    let mm;
    while ((mm = re.exec(secT)) !== null) {
      let ok = true;
      for (let k = mm.index; k < mm.index + mm[0].length; k++) if (!mask2[k]) { ok = false; break; }
      if (ok) throw new Error(`裸标识符残留: ${name}`);
    }
  }
  console.log('裸标识符断言通过');
}

// ---- 组装 media-pipeline.js ----
const header = `/**
 * ffmpeg 引擎解码编排（自包含模块）。
 * 从 index.js 拆出（2026-08）：setupPipeline（MediaPipeline 事件接线 + 背压）。
 * 用法：setCtx({ getConfig, getPipeline, setPipeline, getMediaServer, getCurrentInfo,
 *   getLastKnownTime, sendToRenderer })（bootstrap 时注入；pipeline 是 index.js 顶层变量，
 *   读写走 getter/setter 保持单一事实源）。engine==='mediafoundation' 时不调用。
 */
const { MediaPipeline } = require('./ffmpeg/decoder');
const { PacketType } = require('../shared/protocol');
const { sanitizeInfo } = require('./pip');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getPipeline() { return CTX.getPipeline ? CTX.getPipeline() : null; }
function setPipeline(v) { if (CTX.setPipeline) CTX.setPipeline(v); }
function getMediaServer() { return CTX.getMediaServer ? CTX.getMediaServer() : null; }
function getCurrentInfo() { return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null; }
function getLastKnownTime() { return CTX.getLastKnownTime ? CTX.getLastKnownTime() : 0; }
function sendToRenderer(channel, payload) { if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload); }

`;
const footer = `
module.exports = { setCtx, setupPipeline };
`;
fs.writeFileSync('src/main/media-pipeline.js', header + secT + '\r\n' + footer);
console.log('media-pipeline.js 已写入');

// ---- index.js：删除该段 + require + 调用点 ----
const newLines = [...lines.slice(0, secStart), ...lines.slice(fnEnd + 1)];
let idx = newLines.join('\r\n');

const anchor = "const mpvLaunch = require('./mpv-launch');";
if (!idx.includes(anchor)) throw new Error('找不到 mpvLaunch require 锚点');
idx = idx.replace(anchor, anchor + "\r\nconst mediaPipeline = require('./media-pipeline');");

const callOld = "  if (engine !== 'mediafoundation') setupPipeline();";
if (!idx.includes(callOld)) throw new Error('找不到 setupPipeline 调用点');
idx = idx.replace(callOld, "  if (engine !== 'mediafoundation') mediaPipeline.setupPipeline();");

fs.writeFileSync(INDEX, idx);
console.log('index.js 手术完成（bootstrap 的 setCtx 需手动补 mediaPipeline.setCtx）');
