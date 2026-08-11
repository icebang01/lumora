// 反向漏网扫描 v3：迷你词法器切出"代码区"，再抓自由调用（execute 类 bug）。
// 用法: node tools/scan-reverse-leaks.js <entry.js> [modules...]
// 词法状态机处理: 单双引号字符串 / 模板串 / 行注释 / 块注释 / 正则字面量(近似)，
// 从代码区提取声明与调用引用，避免注释里的引号/标识符污染结果。
const fs = require('fs');

const entryFile = process.argv[2];
const modFiles = process.argv.slice(3);
if (!entryFile || !modFiles.length) {
  console.error('用法: node tools/scan-reverse-leaks.js <entry.js> <modules...>');
  process.exit(1);
}

const GLOBALS = new Set([
  'return','if','else','for','while','function','const','let','var','new','typeof','in','of',
  'switch','case','break','continue','await','async','try','catch','finally','throw','export',
  'import','from','this','true','false','null','undefined','document','window','console','Date',
  'Number','String','Boolean','Object','Array','JSON','Math','Promise','setTimeout','setInterval',
  'clearTimeout','clearInterval','requestAnimationFrame','CustomEvent','MouseEvent','KeyboardEvent',
  'addEventListener','removeEventListener','Node','Element','HTMLElement','parseInt','parseFloat',
  'isNaN','encodeURIComponent','decodeURIComponent','performance','navigator','location','history',
  'getComputedStyle','localStorage','sessionStorage','Event','Proxy','screen','fetch','URL','Blob',
  'Float32Array','Uint8Array','Uint32Array','Int32Array','Uint16Array','ArrayBuffer','DataView',
  'TextEncoder','TextDecoder','FileReader','Image','AudioContext','OfflineAudioContext','WeakMap',
  'Set','Map','Symbol','Reflect','Error','TypeError','RangeError','queueMicrotask','structuredClone',
  'webkitAudioContext','requestIdleCallback','cancelIdleCallback','getSelection','atob','btoa','crypto',
  'Intl','RegExp','Function','Promise','globalThis','process','require','module','exports','__dirname',
]);

/** 返回代码区文本（注释/字符串替换为等长空白，保持行号与相邻性） */
function codeOnly(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
    } else if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = ' '; i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else if (c === "'" || c === '"') {
      const q = c;
      out[i] = ' '; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out[i] = ' '; i++; if (i < n) { out[i] = ' '; i++; } continue; }
        out[i] = ' '; i++;
      }
      if (i < n) { out[i] = ' '; i++; }
    } else if (c === '`') {
      out[i] = ' '; i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { out[i] = ' '; i++; if (i < n) { out[i] = ' '; i++; } continue; }
        // 模板内 ${...} 近似当字符串处理（其中调用不会出现在扫描结果里，可接受）
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          out[i] = ' '; out[i + 1] = ' '; i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            out[i] = ' ';
            i++;
          }
          continue;
        }
        out[i] = ' '; i++;
      }
      if (i < n) { out[i] = ' '; i++; }
    } else {
      i++;
    }
  }
  return out.join('');
}

// 从代码区收集: 声明 / 导出 / 调用引用
function analyze(src) {
  const code = codeOnly(src);
  const declared = new Set();
  const exported = new Set();
  // 声明（function/const/let/var，含 let a, b, c）
  for (const m of code.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*,/g)) declared.add(m[1]);
  for (const m of code.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*[,=]/g)) {
    if (!/^(?:function|const|let|var|return|if|else|case)$/.test(m[1])) declared.add(m[1]);
  }
  // 形参
  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    m[2].split(',').forEach((n) => { const t = n.trim(); if (t) declared.add(t.split('=')[0].trim()); });
  }
  for (const m of code.matchAll(/function\s*\(([^)]*)\)/g)) {
    m[1].split(',').forEach((n) => { const t = n.trim(); if (t) declared.add(t.split('=')[0].trim()); });
  }
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
    m[1].split(',').forEach((n) => { const t = n.trim(); if (t) declared.add(t.split('=')[0].trim()); });
  }
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>\s*\{/g)) { /* 同上，已覆盖 */ }
  // 导出
  for (const m of code.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)/g)) exported.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) exported.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g))
    m[1].split(',').forEach((n) => exported.add(n.trim().split(/\s+as\s+/)[0].trim()));
  // CJS 导出（主进程模块）：module.exports = { a, b }
  for (const m of code.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g))
    m[1].split(',').forEach((n) => exported.add(n.trim().split(/\s*:\s*/).pop().split(/\s+as\s+/)[0].trim()));
  // 导入（entry 的声明，ESM + CJS）
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g))
    m[1].split(',').forEach((n) => declared.add(n.trim().split(/\s+as\s+/)[0].trim()));
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) declared.add(m[1]);
  for (const m of code.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(/g))
    m[1].split(',').forEach((n) => declared.add(n.trim().split(/\s*:\s*/)[0].trim().split(/\s+as\s+/)[0].trim()));
  for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/g)) declared.add(m[1]);
  // CJS 变量解构：const { a, b } = someVar;（模块已 require 到变量，再解构出来）
  for (const m of code.matchAll(/const\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\s*;/g))
    m[1].split(',').forEach((n) => declared.add(n.trim().split(/\s*:\s*/)[0].trim().split(/\s+as\s+/)[0].trim()));
  // 调用引用：name( 且前面不是 . : 或标识符字符
  const callRefs = new Set();
  const re = /(?<![.:\w])([A-Za-z_$][\w$]*)\s*\(/g;
  let mm;
  while ((mm = re.exec(code)) !== null) {
    const w = mm[1];
    if (GLOBALS.has(w) || declared.has(w)) continue;
    callRefs.add(w);
  }
  return { declared, exported, callRefs };
}

const entry = analyze(fs.readFileSync(entryFile, 'utf8'));
const mods = modFiles.map((f) => ({ file: f, ...analyze(fs.readFileSync(f, 'utf8')) }));

let found = false;
for (const ref of [...entry.callRefs].sort()) {
  let matched = false;
  for (const mod of mods) {
    if (mod.declared.has(ref)) {
      matched = true;
      if (!mod.exported.has(ref)) {
        console.log(`漏网(未导出): ${entryFile} 调用 ${mod.file} 内未导出的 '${ref}'`);
        found = true;
      }
    }
  }
  if (!matched) {
    // 没有任何模块声明它：正常自由函数或真全局，不报
    continue;
  }
}
// 方向二：模块导出了、但 entry 声明/导入了却在自由调用里出现 → 宿主漏 import（updatePipControlState 类）
for (const ref of [...entry.callRefs].sort()) {
  for (const mod of mods) {
    if (mod.exported.has(ref)) {
      console.log(`漏网(未导入): ${entryFile} 调用 ${mod.file} 已导出的 '${ref}' 但宿主未导入/声明 → 需补 require/解构`);
      found = true;
    }
  }
}
if (!found) console.log(`${entryFile}: 无自由调用漏网`);
