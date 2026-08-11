#!/usr/bin/env node
/**
 * 静态审计：捕获两类"忘了导入"类 bug
 *  1) CommonJS 主进程：用了 Node 内建模块 (fs/path/os/...) 但没 require
 *  2) ESM 渲染端：import 的具名绑定在目标模块里根本不存在 export
 *
 * 用法：node tools/audit-imports.js [srcDir]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || '.');

// 真正需要 require 的内建模块（排除 process/Buffer/console 等全局）
const NEED_REQUIRE = new Set([
  'fs', 'path', 'os', 'http', 'https', 'net', 'dgram', 'url', 'crypto',
  'child_process', 'util', 'stream', 'zlib', 'events', 'querystring',
  'dns', 'tls', 'assert', 'readline', 'perf_hooks', 'worker_threads', 'v8',
]);

// 额外全局（Node/浏览器全局，无需 require）
const EXTRA_GLOBALS = new Set(['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Blob', 'File']);

// 全局对象（无需 require / import）
const GLOBALS = new Set([
  'process', 'Buffer', 'console', 'global', 'globalThis', '__dirname',
  '__filename', 'module', 'exports', 'require', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'Promise', 'Math', 'JSON', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'document', 'window', 'navigator', 'localStorage', 'sessionStorage',
  'HTMLElement', 'CustomEvent', 'Event', 'Node', 'Element', 'requestAnimationFrame',
  'cancelAnimationFrame', 'fetch', 'structuredClone',
]);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'coverage', 'testmedia', 'dist', 'build'].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith('.js')) {
      out.push(p);
    }
  }
}

const files = [];
walk(path.resolve(ROOT, 'src'), files);

let problems = 0;

// ---------- 收集每个模块的具名 export ----------
function collectExports(src) {
  const names = new Set();
  const reFn = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g;
  const reConst = /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g;
  const reClass = /export\s+class\s+([A-Za-z0-9_$]+)/g;
  const reBrace = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = reFn.exec(src))) names.add(m[1]);
  while ((m = reConst.exec(src))) names.add(m[1]);
  while ((m = reClass.exec(src))) names.add(m[1]);
  while ((m = reBrace.exec(src))) {
    for (let part of m[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      const as = part.split(/\s+as\s+/);
      // `X` 或 `X as Y` 或 `Y as X`(re-export)? 普通 export {a,b}：导出 a,b
      const exported = as.length === 2 ? as[1].trim() : part;
      names.add(exported);
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

// ---------- 收集本地声明/参数（用于排除局部变量误报） ----------
function collectLocals(src) {
  const locals = new Set();
  let m;
  const reDecl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reDecl.exec(src))) locals.add(m[1]);
  const reFn = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  while ((m = reFn.exec(src))) {
    locals.add(m[1]);
    for (const p of m[2].split(',')) {
      const pn = p.trim().split(/[:=?\s/]/)[0].replace(/\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(pn)) locals.add(pn);
    }
  }
  const reArrow = /\(([^)]*)\)\s*=>/g;
  while ((m = reArrow.exec(src))) {
    for (const p of m[1].split(',')) {
      const pn = p.trim().split(/[:=?\s/]/)[0].replace(/\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(pn)) locals.add(pn);
    }
  }
  return locals;
}

// ---------- 审计主进程（CommonJS）漏 require ----------
function auditCommonJS(file) {
  const src = fs.readFileSync(file, 'utf8');
  const locals = collectLocals(src);
  // 已 require 的模块
  const required = new Set();
  const reReq = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = reReq.exec(src))) required.add(m[1]);

  // 裸标识符 X. 用法（非对象属性：前面不是 . 或字母数字）
  const reUse = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\./g;
  const used = new Set();
  while ((m = reUse.exec(src))) {
    const id = m[2];
    if (GLOBALS.has(id) || EXTRA_GLOBALS.has(id) || locals.has(id)) continue;
    if (NEED_REQUIRE.has(id) && !required.has(id)) used.add(id);
  }
  if (used.size) {
    problems++;
    console.log(`[require?] ${path.relative(ROOT, file)} 用了但未 require: ${[...used].join(', ')}`);
  }
}

// ---------- 审计渲染端（ESM）import 名缺失 export ----------
function auditESM(file, exportMap) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/^\s*import\s/m.test(src)) return; // 非 ESM 或不 import
  const reImp = /import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = reImp.exec(src))) {
    const clause = m[1];
    const spec = m[2];
    if (!spec.startsWith('.')) continue; // 只查相对路径本地模块
    // 目标模块绝对路径
    let target;
    try {
      target = spec.startsWith('.')
        ? path.resolve(path.dirname(file), spec)
        : null;
    } catch { continue; }
    if (!target) continue;
    if (!fs.existsSync(target)) {
      problems++;
      console.log(`[missing-file] ${path.relative(ROOT, file)} 引用的模块不存在: ${spec}`);
      continue;
    }
    const exp = exportMap.get(target);
    if (!exp) continue;
    // 解析具名导入 { a as b, c }
    const brace = clause.match(/\{([^}]*)\}/);
    if (brace) {
      for (let part of brace[1].split(',')) {
        part = part.trim();
        if (!part) continue;
        const as = part.split(/\s+as\s+/);
        const sourceName = (as.length === 2 ? as[0] : part).trim();
        if (!exp.has(sourceName) && sourceName !== 'default') {
          problems++;
          console.log(`[no-export] ${path.relative(ROOT, file)} import { ${sourceName} } from '${spec}' —— 目标模块未 export 该名`);
        }
      }
    }
    // default 导入：import X from '...'
    if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(clause.trim()) && !exp.has('default')) {
      problems++;
      console.log(`[no-default] ${path.relative(ROOT, file)} 默认导入 '${spec}' —— 目标模块无 default export`);
    }
  }
}

// 先收集所有 ESM 模块 export
const exportMap = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (/^\s*import\s/m.test(src)) {
    exportMap.set(f, collectExports(src));
  }
}

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (/\brequire\s*\(/.test(src) && !/^\s*import\s/m.test(src)) {
    auditCommonJS(f);
  } else {
    auditESM(f, exportMap);
  }
}

if (problems === 0) {
  console.log('OK  未发现漏 import / 漏 require 类问题');
} else {
  console.log(`\n共发现 ${problems} 处潜在问题`);
}
process.exitCode = problems === 0 ? 0 : 1;
