// Lumora app.js 拆分第 N 轮：迁出输入绑定到 input.js（一次性手术脚本，可重复执行校验）
// 1) context-menu.js: execute 补 export（此前拆分漏网：app.js bindInput 调用未导出的 execute → ReferenceError）
// 2) app.js: 删 bindInput/bindDragDrop/bindAudioUnlock/bindClickToFront/isEditable/isUiTarget/isNonRepeatable/naturalCompare/escapeHtml(死代码) + 改 import + boot 注入 setupInput
const fs = require('fs');

function readLines(f) {
  const s = fs.readFileSync(f, 'utf8');
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  return { lines: s.split(/\r?\n/), nl };
}
function writeLines(f, lines, nl) { fs.writeFileSync(f, lines.join(nl)); }

function mustCount(text, needle, expect, label) {
  const c = text.split(needle).length - 1;
  if (c !== expect) throw new Error(`断言失败 ${label}: 期望 ${expect} 次, 实际 ${c} 次`);
  console.log(`  ok ${label} (${c} 次)`);
}

// ---------- context-menu.js: execute 补 export ----------
{
  const f = 'src/renderer/panels/context-menu.js';
  const { lines, nl } = readLines(f);
  const src = lines.join(nl);
  if (src.includes('export function execute(hit) {')) {
    console.log('context-menu.js: execute 已导出（跳过）');
  } else {
    mustCount(src, 'function execute(hit) {', 1, 'context-menu execute 定义');
    fs.writeFileSync(f, src.replace('function execute(hit) {', 'export function execute(hit) {'));
    console.log('context-menu.js: execute 已补 export');
  }
}

// ---------- app.js ----------
{
  const f = 'src/renderer/app.js';
  const { lines, nl } = readLines(f);

  // 行范围删除（自底向上，1 基含端点）——先断言再删
  const ranges = [
    { a: 1081, b: 1084, probe: /^function naturalCompare/, label: 'naturalCompare' },
    { a: 1051, b: 1078, probe: /^function isEditable/, label: 'isEditable/isUiTarget/陈旧注释/isNonRepeatable' },
    { a: 1005, b: 1046, probe: /^\/\* =/, probe2: '已迁移', label: '陈旧设置窗口注释+bindDragDrop' },
    { a: 864, b: 989, probe: /^function bindInput/, label: 'bindInput+陈旧右键菜单注释' },
    { a: 747, b: 794, probe: /^\/\* =/, probe2: '输入', label: '输入段(bindAudioUnlock/bindClickToFront)' },
    { a: 49, b: 54, probe: /^function escapeHtml/, label: 'escapeHtml(死代码)' },
  ];
  for (const r of ranges) {
    if (!lines[r.a - 1] || !r.probe.test(lines[r.a - 1])) throw new Error(`范围起点不符 ${r.label}: 第${r.a}行=${JSON.stringify(lines[r.a - 1])}`);
    if (r.probe2 !== undefined && !lines[r.a].includes(r.probe2)) throw new Error(`范围起点第二行不符 ${r.label}: ${JSON.stringify(lines[r.a])}`);
  }
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    const removed = lines.splice(r.a - 1, r.b - r.a + 1);
    console.log(`  删 [${r.a}-${r.b}] ${r.label} (${removed.length} 行)`);
  }

  let src = lines.join(nl);

  // 字符串替换（唯一性断言）
  mustCount(src, "import { KeybindManager, keyCandidates, wheelCandidates, mouseCandidates } from './ui/keys.js';", 1, 'keys.js import');
  src = src.replace("import { KeybindManager, keyCandidates, wheelCandidates, mouseCandidates } from './ui/keys.js';",
    "import { KeybindManager } from './ui/keys.js';");

  mustCount(src, "import { fmtTime, Player, trackLabel } from './core/player.js';", 1, 'player.js import');
  src = src.replace("import { fmtTime, Player, trackLabel } from './core/player.js';",
    "import { Player } from './core/player.js';");

  mustCount(src, "import { KeybindEditor } from './ui/keybind-editor.js';" + nl, 1, 'KeybindEditor import');
  src = src.replace("import { KeybindEditor } from './ui/keybind-editor.js';" + nl, '');

  const feedbackImport = "import { setupFeedback, bindPlayerFeedback, clearAudioExtras, clearQualityBadges } from './panels/feedback.js';";
  mustCount(src, feedbackImport, 1, 'feedback.js import');
  src = src.replace(feedbackImport,
    feedbackImport + nl + "import { setupInput, bindInput, bindDragDrop, bindAudioUnlock, bindClickToFront } from './input.js';");

  const bootOld = '  bindInput();' + nl + '  bindAudioUnlock();' + nl + '  bindClickToFront();';
  mustCount(src, bootOld, 1, 'boot 绑定调用');
  src = src.replace(bootOld,
    '  setupInput({ player, osd, osc, keybinds, keymap, runCommand, openDialog, toggleKeymap, setPlaylist, load });' + nl +
    '  bindInput();' + nl + '  bindAudioUnlock();' + nl + '  bindClickToFront();');

  fs.writeFileSync(f, src);
  console.log('app.js 手术完成');
}
