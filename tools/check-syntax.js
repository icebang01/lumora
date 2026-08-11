// 全仓 JS 语法检查（node tools/check-syntax.js）
// 用途：CI/提交前快速门禁——捕获拆分引入的语法错误。
// 处理：renderer 是 ESM（import/export），node --check 按 CJS 解析会误报。
// 旧实现：对每个文件复制成临时 .mjs 再 `node --check`（每个文件 spawn 一个子进程）。
//        在受限沙箱里一次性 spawn 上百个子进程会被环境杀死，导致门禁假失败。
// 新实现：进程内用 vm 解析——CJS 走 vm.Script，ESM 走 vm.SourceTextModule，
//        零子进程，既快又不会被沙箱误杀。SourceTextModule 需 --experimental-vm-modules，
//        缺失时仅自举一次（1 个子进程）开启标志后继续。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'tools', 'test'];
const SKIP = ['node_modules'];

if (typeof vm.SourceTextModule !== 'function') {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (SKIP.includes(name)) continue;
      walk(p, out);
    } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
      out.push(p);
    }
  }
}

const files = [];
for (const d of DIRS) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walk(full, files);
}

let failed = 0;
const ctx = vm.createContext({});
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const code = fs.readFileSync(file, 'utf8');
  const isEsm = file.endsWith('.mjs') || /\bimport\s|\bexport\s|\bimport\(/.test(code);
  let ok = false;
  try {
    if (isEsm) {
      // 仅解析（不链接/不执行），语法错误会在构造时抛出
      new vm.SourceTextModule(code, { identifier: file, context: ctx });
    } else {
      // vm.Script 只编译不执行，等价于 --check
      new vm.Script(code, { filename: file });
    }
    ok = true;
  } catch (e) {
    ok = false;
    console.error('FAIL', rel);
    console.error(String((e && e.message) ? e.message : e).split('\n').slice(0, 4).join('\n'));
  }
  if (ok) console.log('OK  ', rel, isEsm ? '(esm)' : '');
  else failed++;
}
console.log(`\n${files.length} 个文件，${failed} 个失败`);
process.exitCode = failed ? 1 : 0;
