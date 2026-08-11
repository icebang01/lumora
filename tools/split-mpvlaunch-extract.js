// Lumora index.js 拆分：MPV 后端段（resolveMpvPath/createMpvBackend/startMpv）迁出到 mpv-launch.js
const fs = require('fs');
const INDEX = 'src/main/index.js';
const lines = fs.readFileSync(INDEX, 'utf8').split(/\r?\n/);

// ---- 定位 MPV 后端段：从「MPV 后端」小节头到 setupPipeline 小节头之前 ----
const secStart = lines.findIndex((l) => l.includes('/* MPV 后端'));
if (secStart === -1) throw new Error('找不到 MPV 后端小节');
// 小节头 3 行 + 到「解码编排」小节头前
const secEnd = lines.findIndex((l, i) => i > secStart && l.includes('/* 解码编排'));
if (secEnd === -1) throw new Error('找不到解码编排小节');
console.log(`MPV 后端段: 行 ${secStart + 1}-${secEnd} (${secEnd - secStart} 行)`);

const section = lines.slice(secStart, secEnd).join('\r\n');
// 断言 3 个函数都在段内
for (const fn of ['function resolveMpvPath', 'function createMpvBackend', 'async function startMpv']) {
  if (!section.includes(fn)) throw new Error(`段内缺少 ${fn}`);
}

// ---- 代码区掩码（复用） ----
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

// ---- 单遍替换（仅代码区）----
const COMBINED = /(mpvBackend\s*=\s*new\s+MpvBackend\(\{\s*mpvPath,\s*config\}\);|\bmpvBackend\b|\bconfig\b)/g;
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
      if (m[0].includes('= new MpvBackend')) rep = 'setMpvBackend(new MpvBackend({ mpvPath, config: getConfig() }));';
      else if (m[0] === 'mpvBackend') rep = 'getMpvBackend()';
      else rep = 'getConfig()';
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

// 断言：无裸标识符残留（代码区）
{
  const mask2 = codeMask(secT);
  for (const name of ['mpvBackend', 'config']) {
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

// ---- 组装 mpv-launch.js ----
const header = `/**
 * MPV 后端启动（自包含模块）。
 * 从 index.js 拆出（2026-08）：resolveMpvPath / createMpvBackend / startMpv。
 * 用法：setCtx({ getConfig, getMpvBackend, setMpvBackend, sendToRenderer })（bootstrap 时注入；
 * mpvBackend 是 index.js 顶层变量，读写走 getter/setter 保持单一事实源）。
 * 注意：createMpvBackend 必须在窗口创建前调用（渲染端 boot() 可能先于 startMpv 触发 loadFile）。
 */
const path = require('path');
const fs = require('fs');
const { resolveBinary } = require('./ffmpeg/binaries');
const { MpvBackend } = require('./mpv-backend');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getMpvBackend() { return CTX.getMpvBackend ? CTX.getMpvBackend() : null; }
function setMpvBackend(v) { if (CTX.setMpvBackend) CTX.setMpvBackend(v); }
function sendToRenderer(channel, payload) { if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload); }

`;
const footer = `
module.exports = { setCtx, resolveMpvPath, createMpvBackend, startMpv };
`;
fs.writeFileSync('src/main/mpv-launch.js', header + secT + '\r\n' + footer);
console.log('mpv-launch.js 已写入');

// ---- index.js：删除该段 ----
const newLines = [...lines.slice(0, secStart), ...lines.slice(secEnd)];
let idx = newLines.join('\r\n');

// 插入 require（register-ipc require 之后）
const anchor = "const ipc = require('./register-ipc');";
if (!idx.includes(anchor)) throw new Error('找不到 ipc require 锚点');
idx = idx.replace(anchor, anchor + "\r\nconst mpvLaunch = require('./mpv-launch');" +
  "\r\nconst { createMpvBackend, startMpv, resolveMpvPath } = mpvLaunch;");

fs.writeFileSync(INDEX, idx);
console.log('index.js 手术完成（require 已加，bootstrap 的 setCtx 需手动补 mpvLaunch.setCtx）');
