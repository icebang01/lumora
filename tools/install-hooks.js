// 零依赖：把 tools/hooks/* 安装到 .git/hooks/ 并置可执行。
// 由 package.json 的 "prepare" 脚本在 npm install / npm ci 时自动调用。
// CI 下 npm ci 也会触发本脚本，但 CI 不提交，钩子不会运行，故无害。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const hooksSrc = path.join(ROOT, 'tools', 'hooks');
const hooksDst = path.join(ROOT, '.git', 'hooks');

if (!fs.existsSync(hooksDst)) {
  console.log('[install-hooks] 未找到 .git/hooks（非 git 仓库？），跳过');
  process.exit(0);
}

if (!fs.existsSync(hooksSrc)) {
  console.log('[install-hooks] 未找到 tools/hooks，跳过');
  process.exit(0);
}

let count = 0;
for (const name of fs.readdirSync(hooksSrc)) {
  if (name.endsWith('.sample')) continue;
  const src = path.join(hooksSrc, name);
  const dst = path.join(hooksDst, name);
  if (fs.existsSync(dst) && !fs.statSync(dst).isFile()) continue; // 不覆盖非普通文件
  fs.copyFileSync(src, dst);
  try { fs.chmodSync(dst, 0o755); } catch (_) { /* Windows 上 chmod 可能无效，不影响 Git Bash 执行 */ }
  count++;
  console.log('[install-hooks] 已安装 ' + name);
}
console.log(`[install-hooks] 完成，共 ${count} 个钩子（首次 clone 后 npm install 会自动执行）`);
