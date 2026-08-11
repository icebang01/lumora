/**
 * Lumora 一键修复脚本
 *
 * 修复内容：
 *   1. 删除 addHistory IPC 路径（消除主进程弹窗）
 *   2. 修复 pip.js 缺少 syncWindows import（PiP 退出崩溃）
 *
 * 用法：node fix-addhistory.js
 * 在 D:\IDEA\videos 目录下运行
 * 运行后重启 Lumora（npm start）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname);
const ERRORS = [];
let fixedCount = 0;

function patchFile(relPath, oldStr, newStr, desc) {
  const fullPath = path.join(BASE, relPath);
  if (!fs.existsSync(fullPath)) {
    ERRORS.push(`[FAIL] 文件不存在: ${relPath}`);
    return false;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  // 已修过（新内容已存在 或 目标文本不在文件中且不是空替换）
  const alreadyFixed = (newStr && content.includes(newStr)) ||
    (!newStr && !content.includes(oldStr));
  if (alreadyFixed) {
    console.log(`[SKIP] 已修复或无需修复: ${relPath} (${desc})`);
    return true;
  }
  const patched = content.replace(oldStr, newStr);
  fs.writeFileSync(fullPath, patched, 'utf8');
  console.log(`[OK] ${relPath}: ${desc}`);
  fixedCount++;
  return true;
}

console.log('=== Lumora 一键修复 ===\n');

// ════════════════════════════════════════
// 修复 #1: 删除 addHistory IPC 路径
// ════════════════════════════════════════
console.log('--- [1/4] 删除 addHistory IPC 路径 ---\n');

patchFile(
  'src/main/ipc-media.js',
  `  ipcMain.handle('app:add-history', (_e, entry) => { addHistory(entry); return { ok: true }; });

  ipcMain.handle('app:clear-history', () => {`,
  `  ipcMain.handle('app:clear-history', () => {`,
  '删除 app:add-history handler'
);

patchFile(
  'src/main/ipc-media.js',
  "const { loadHistory, addHistory, clearHistory, removeHistory } = require('./history-store');",
  "const { loadHistory, clearHistory, removeHistory } = require('./history-store');",
  'import 移除 addHistory'
);

patchFile(
  'src/main/preload.js',
  `  addHistory: (entry) => ipcRenderer.invoke('app:add-history', entry),
  clearHistory: () => ipcRenderer.invoke('app:clear-history'),`,
  `  clearHistory: () => ipcRenderer.invoke('app:clear-history'),`,
  '删除 preload addHistory 桥接'
);

// ════════════════════════════════════════
// 修复 #2: pip.js 补上 windows.js 缺失的 import
// ════════════════════════════════════════
console.log('\n--- [2/4] 修复 pip.js windows.js 未定义引用 ---\n');

// 统一替换：无论当前 import 行是什么状态，都写成完整版
const pipPath = path.join(BASE, 'src/main/pip.js');
let pipContent = fs.readFileSync(pipPath, 'utf8');
const FULL_IMPORT = "const { syncWindows: doSyncWindows, resyncNow: doResyncNow, setFullscreen: doSetFullscreen } = require('./windows');";

if (pipContent.includes("require('./windows')")) {
  // 已有 require('./windows')，替换为完整版
  pipContent = pipContent.replace(
    /const \{[^}]*\}\s*=\s*require\('\.\/windows'\);?/,
    FULL_IMPORT
  );
  console.log('[OK] pip.js: 更新 windows.js import 为完整版（3 函数）');
} else if (pipContent.includes("const { BrowserWindow, screen } = require('electron');")) {
  // 没有 windows import，在 electron 后面插入
  pipContent = pipContent.replace(
    "const { BrowserWindow, screen } = require('electron');",
    "const { BrowserWindow, screen } = require('electron');\n" + FULL_IMPORT
  );
  console.log('[OK] pip.js: 新增 windows.js import（3 函数）');
} else {
  ERRORS.push('[FAIL] pip.js: 找不到合适的插入点');
}
fs.writeFileSync(pipPath, pipContent, 'utf8');

// 替换所有裸调用为 do* 前缀版本
pipContent = fs.readFileSync(pipPath, 'utf8');
let pipPatched = pipContent;
pipPatched = pipPatched.replace(/\bsyncWindows\(\)/g, 'doSyncWindows()');
pipPatched = pipPatched.replace(/\bresyncNow\(\)/g, 'doResyncNow()');
pipPatched = pipPatched.replace(/(?<!do)setFullscreen\(([^)]*)\)/g, 'doSetFullscreen($1)');
if (pipPatched !== pipContent) {
  fs.writeFileSync(pipPath, pipPatched, 'utf8');
  console.log('[OK] pip.js: 所有调用已改为 do* 前缀版本');
  fixedCount++;
}

// ════════════════════════════════════════
// 修复 #3: 播放列表面板改为右侧滑入侧边栏
// ════════════════════════════════════════
console.log('\n--- [3/5] 播放列表 → 右侧侧边栏 ---\n');

const cssPath = path.join(BASE, 'src/renderer/style.css');
let cssContent = fs.readFileSync(cssPath, 'utf8');

// 检测是否已经是侧边栏版本
if (cssContent.includes('slide-in-right') && cssContent.includes('justify-content: flex-end')) {
  console.log('[SKIP] style.css 已是侧边栏版本');
} else {
  const OLD_PANEL_CSS = `#playlist-panel {
  position: fixed; inset: 0; z-index: 49;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  -webkit-app-region: no-drag;
}
#playlist-panel:not(.hidden) { pointer-events: auto; }
.playlist-backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,.45);
  animation: fade-in .2s var(--ease) both;
  -webkit-app-region: no-drag;
}
.playlist-window {
  position: relative;
  width: min(440px, 90vw);
  max-height: 72vh;
  display: flex; flex-direction: column;
  background: rgba(20,22,32,.72);
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 16px;
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  box-shadow: 0 24px 60px rgba(0,0,0,.5);
  overflow: hidden;
  animation: pop-in .26s var(--ease) both;
  -webkit-app-region: no-drag;
}`;

  const NEW_SIDEBAR_CSS = `#playlist-panel {
  position: fixed; inset: 0; z-index: 49;
  display: flex; align-items: stretch; justify-content: flex-end;
  pointer-events: none;
  -webkit-app-region: no-drag;
}
#playlist-panel:not(.hidden) { pointer-events: auto; }
.playlist-backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,.30);
  animation: fade-in .25s var(--ease) both;
  -webkit-app-region: no-drag;
}
.playlist-window {
  position: relative;
  width: min(380px, 85vw);
  max-height: 100vh;
  display: flex; flex-direction: column;
  background: rgba(20,22,32,.82);
  border-left: 1px solid rgba(255,255,255,.10);
  border-radius: 0;
  backdrop-filter: blur(28px) saturate(170%);
  -webkit-backdrop-filter: blur(28px) saturate(170%);
  box-shadow: -8px 0 40px rgba(0,0,0,.45);
  overflow: hidden;
  animation: slide-in-right .3s cubic-bezier(.16,1,.3,1) both;
  -webkit-app-region: no-drag;
}
@keyframes slide-in-right {
  from { opacity: 0; transform: translateX(100%); }
  to   { opacity: 1; transform: translateX(0); }
}`;

  if (cssContent.includes(OLD_PANEL_CSS)) {
    cssContent = cssContent.replace(OLD_PANEL_CSS, NEW_SIDEBAR_CSS);
    fs.writeFileSync(cssPath, cssContent, 'utf8');
    console.log('[OK] style.css: 播放列表面板已改为右侧滑入侧边栏');
    fixedCount++;
  } else if (!cssContent.includes('slide-in-right')) {
    // 尝试模糊匹配：只替换 #playlist-panel 块
    ERRORS.push('[WARN] style.css 播放列表面板 CSS 未匹配，可能已被手动修改');
    console.log('[WARN] 请手动将播放列表面板改为侧边栏，或检查 style.css 是否有冲突改动');
  } else {
    console.log('[SKIP] style.css 已包含侧边栏样式（部分匹配）');
  }
}

// ════════════════════════════════════════
// 验证
// ════════════════════════════════════════
console.log('\n--- [4/5] 验证 ---\n');

const preloadContent = fs.readFileSync(path.join(BASE, 'src/main/preload.js'), 'utf8');
const ipcMediaContent = fs.readFileSync(path.join(BASE, 'src/main/ipc-media.js'), 'utf8');
// pipContent 已在上面修复 #2 时读取/修改过，直接复用

if (preloadContent.includes('addHistory')) {
  ERRORS.push('[FAIL] preload.js 仍包含 addHistory！');
} else {
  console.log('[OK] preload.js: addHistory 已清除');
}

if (ipcMediaContent.includes('addHistory')) {
  const lines = ipcMediaContent.split('\n').filter(l => l.includes('addHistory'));
  if (lines.length > 0) {
    ERRORS.push(`[FAIL] ipc-media.js 仍含 ${lines.length} 行 addHistory`);
  }
} else {
  console.log('[OK] ipc-media.js: addHistory 已清除');
}

if (pipContent.includes("require('./windows')")) {
  console.log('[OK] pip.js: 已导入 windows.js');
} else {
  ERRORS.push('[FAIL] pip.js 未导入 windows.js');
}

// 验证三个函数都已正确 import + 调用
const winFuncs = [
  { orig: 'syncWindows', alias: 'doSyncWindows' },
  { orig: 'resyncNow', alias: 'doResyncNow' },
  { orig: 'setFullscreen', alias: 'doSetFullscreen' },
];
for (const f of winFuncs) {
  const hasAlias = pipContent.includes(f.alias);
  // 检查是否还有裸调用（排除 import 行里的属性名和注释）
  const bareCallRegex = new RegExp(`(?<![\\w.:])${f.orig}\\s*\\(`, 'g');
  const bareCalls = (pipContent.match(bareCallRegex) || []).length;
  if (hasAlias && bareCalls === 0) {
    console.log(`[OK] pip.js: ${f.orig} → ${f.alias}() 已修正`);
  } else {
    ERRORS.push(`[FAIL] pip.js ${f.orig} 调用未修正 (alias=${hasAlias}, bareCalls=${bareCalls})`);
  }
}

// ════════════════════════════════════════
// 清除缓存
// ════════════════════════════════════════
console.log('\n--- [5/5] 清除 Electron 缓存 ---\n');
// 清掉 Electron 全部缓存目录，防止旧主进程/渲染代码被缓存命中
const electronCacheRoot = path.join(process.env.APPDATA || '', 'electron');
const cacheSubDirs = ['Code Cache', 'GPUCache', 'blob_storage', 'Local Storage', 'Session Storage'];
let clearedAny = false;
for (const sub of cacheSubDirs) {
  const dir = path.join(electronCacheRoot, sub);
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[OK] 已清除 ${sub}`);
      clearedAny = true;
    } catch (e) {
      console.log(`[WARN] 清除 ${sub} 失败（可忽略）: ${e.message}`);
    }
  }
}
if (!clearedAny) console.log('[SKIP] 未发现 Electron 缓存目录（首次运行或已清）');

// 诊断：确认自动加入同目录媒体功能是否已部署
console.log('\n--- 功能部署诊断 ---');
const featChecks = [
  { file: 'src/main/file-assoc.js', marker: 'function scanSiblings', name: 'scanSiblings 函数' },
  { file: 'src/main/ipc-player.js', marker: "player:scan-siblings", name: 'player:scan-siblings IPC' },
  { file: 'src/main/preload.js', marker: 'scanSiblings:', name: 'preload 桥接' },
  { file: 'src/renderer/input.js', marker: 'scanSiblings(paths[0])', name: 'drop 自动展开逻辑' },
  { file: 'src/main/config.js', marker: "auto-add-siblings", name: 'auto-add-siblings 配置' },
];
let featOk = true;
for (const c of featChecks) {
  const fp = path.join(BASE, c.file);
  if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes(c.marker)) {
    console.log(`[OK] ${c.name} 已部署`);
  } else {
    console.log(`[FAIL] ${c.name} 未部署 (${c.file})`);
    featOk = false;
  }
}
if (!featOk) {
  ERRORS.push('[FAIL] 自动加入同目录媒体功能未完整部署，请重新拉取最新代码');
}

// ════════════════════════════════════════
// 汇总
// ════════════════════════════════════════
console.log('\n=== 结果 ===');
if (ERRORS.length > 0) {
  console.log('❌ 有错误:');
  ERRORS.forEach(e => console.log(`   ${e}`));
  process.exit(1);
} else {
  console.log(`✅ 全部修复完成！共修改 ${fixedCount} 处`);
  console.log('\n下一步：');
  console.log('  1. taskkill /F /IM electron.exe');
  console.log('  2. npm start');
}
