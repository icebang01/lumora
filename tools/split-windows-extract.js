// Lumora index.js 拆分：迁出窗口域到 windows.js（一次性手术脚本，带断言）
const fs = require('fs');
const f = 'src/main/index.js';
const nl = '\r\n';
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);

// 断言块边界
function probe(idx1, re, label) {
  if (!lines[idx1 - 1] || !re.test(lines[idx1 - 1])) {
    throw new Error(`断言失败 ${label}: 第${idx1}行=${JSON.stringify(lines[idx1 - 1])}`);
  }
}
probe(137, /^\/\* -/, '窗口段头');
probe(138, /窗口/, '窗口段头2');
probe(141, /^function computeWindowSize/, 'computeWindowSize');
probe(557, /^}$/, 'attachRendererDiagnostics 结尾');
probe(559, /^function sendToRenderer/, 'sendToRenderer 起点');

// 删除 137-558（窗口段 + 尾部空行），保留 sendToRenderer
const removed = lines.splice(136, 558 - 137 + 1);
console.log(`删 [137-558] 窗口段 (${removed.length} 行)`);

let src = lines.join(nl);

// 1) require windows.js（插在 playControl require 之后）
const anchor = "const { loadFile, applyAspectRatio, currentDar } = playControl;";
if (!src.includes(anchor)) throw new Error('找不到 playControl require 锚点');
src = src.replace(anchor, anchor + nl + "const windows = require('./windows');" + nl +
  'const { createWindow, resyncNow, setFullscreen, ensureVideoWindow } = windows;');

// 2) bootstrap 开头注入 windows.setCtx（win/videoWin 单一事实源留在 index.js）
const bootAnchor = 'async function bootstrap() {';
if (!src.includes(bootAnchor)) throw new Error('找不到 bootstrap 锚点');
src = src.replace(bootAnchor, bootAnchor + nl +
  '  // 窗口模块上下文注入（win/videoWin 是 index.js 的顶层变量，读写走 getter/setter 保持单一事实源）' + nl +
  '  windows.setCtx({' + nl +
  '    getWin: () => win,' + nl +
  '    setWin: (v) => { win = v; },' + nl +
  '    getVideoWin: () => videoWin,' + nl +
  '    setVideoWin: (v) => { videoWin = v; },' + nl +
  '    getConfig: () => config,' + nl +
  '    getUseMpv: () => useMpv,' + nl +
  '    getCurrentInfo: () => currentInfo,' + nl +
  '    getIsDev: () => IS_DEV,' + nl +
  '    getIsSmoke: () => SMOKE,' + nl +
  '    sendToRenderer,' + nl +
  '    startMpv: (w) => startMpv(w),' + nl +
  '  });');

fs.writeFileSync(f, src);
console.log('index.js 手术完成');
