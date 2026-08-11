// 备用推送：GitHub Contents API（github.com:443 不通时使用，api.github.com 可达）
// 用法：node tools/push-contents.js <file1> [file2...]  —— 新文件或带 SHA 更新
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'icebang01/lumora';
const BRANCH = 'main';
const files = process.argv.slice(2);
if (!files.length) { console.error('用法: node tools/push-contents.js <file>...'); process.exit(1); }
// 路径按段编码，保留 '/'（Windows '\' 也归一），避免 encodeURIComponent 把分隔符编码成 %2F 导致子目录文件失败
const encPath = (p) => p.split(/[\\/]/).map(encodeURIComponent).join('/');

for (const f of files) {
  const content = fs.readFileSync(f).toString('base64');
  const tmp = path.join(__dirname, `.push-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  // 更新已有文件需带 sha；先查
  let sha = null;
  try {
    const cur = execFileSync('gh', ['api', `repos/${REPO}/contents/${encPath(f)}`, '--jq', '.sha'], { encoding: 'utf8' }).trim();
    if (cur && cur !== 'null') sha = cur;
  } catch { /* 新文件 */ }
  const payload = JSON.stringify({
    message: sha ? `chore: update ${f}（Contents API）` : `chore: add ${f}（Contents API）`,
    content,
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  });
  fs.writeFileSync(tmp, payload);
  try {
    const out = execFileSync('gh', ['api', `repos/${REPO}/contents/${encPath(f)}`, '--method', 'PUT', '--input', tmp], { encoding: 'utf8' });
    const j = JSON.parse(out);
    console.log(`OK ${f} → ${j.content.sha.slice(0, 7)}`);
  } catch (e) {
    console.error(`FAIL ${f}:`, (e.stderr || e.message).toString().slice(0, 300));
    process.exitCode = 1;
  } finally {
    fs.unlinkSync(tmp);
  }
}
