'use strict';
// 网络串流（block #4a）命令接线单测：
//  - default-keybinds 必须含 Ctrl+u → open-network-stream（与打开文件键并列）
//  - keys.describeBind / groupOf 必须正确归类该命令，键位速查面板才会显示
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { DEFAULT_KEYBINDS } = require('../../src/shared/default-keybinds');

let keys;
before(async () => {
  // keys.js 是浏览器 ESM（.js 在 commonjs 工程下会被当 CJS 解析而炸 export），
  // 复制为 .mjs 后动态导入，与 pixfmt-drift 测试同手法。
  const src = path.join(__dirname, '..', '..', 'src', 'renderer', 'ui', 'keys.js');
  const tmp = path.join(os.tmpdir(), `keys-${process.pid}.mjs`);
  fs.copyFileSync(src, tmp);
  keys = await import(pathToFileURL(tmp).href);
});

test('default-keybinds：含 Ctrl+u open-network-stream', () => {
  assert.ok(/Ctrl\+u\s+open-network-stream/i.test(DEFAULT_KEYBINDS),
    'default-keybinds 缺少 Ctrl+u → open-network-stream 绑定');
});

test('describeBind：open-network-stream → 打开网络串流…', () => {
  assert.equal(keys.describeBind({ command: 'open-network-stream' }), '打开网络串流…');
});

test('groupOf：open-network-stream 归入「文件」分组', () => {
  assert.equal(keys.groupOf({ command: 'open-network-stream' }), '文件');
});
