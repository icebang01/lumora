'use strict';
// 像素格式表漂移检测：主进程 protocol.js 与渲染端 wire.js 各持一份 PixelFormats。
// 浏览器 ESM 无法 require CJS 的 protocol.js，双份短期不可避免——本测试保证它们不漂移。
// wire.js 是浏览器 ESM，Node 按 CJS 解析 .js 会炸 export —— 复制为 .mjs 后动态导入。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before } = require('node:test');
const assert = require('node:assert');
const proto = require('../../src/shared/protocol');

let wire;
before(async () => {
  const tmp = path.join(os.tmpdir(), `wire-${process.pid}.mjs`);
  fs.copyFileSync(path.join(__dirname, '../../src/renderer/core/wire.js'), tmp);
  try {
    wire = await import(pathToFileURL(tmp).href); // Windows 绝对路径必须 file:// URL
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('双份像素格式表键集合一致', () => {
  const wireKeys = Object.keys(wire.PixelFormats).sort();
  const protoKeys = ['yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'];
  assert.deepEqual(wireKeys, protoKeys.sort(), 'wire 表与 protocol 表格式集合不一致（新增格式必须两处同步）');
});

test('每个格式：protocol 认识 + planeLayout 与 frameSize 行为一致', async () => {
  for (const key of Object.keys(wire.PixelFormats)) {
    const wf = wire.PixelFormats[key];
    assert.equal(proto.normalizePixFmt(key, wf.bitDepth), key, `protocol 不认识 ${key}`);
    // 偶数与奇数尺寸都验证（ceil 边界）
    for (const [w, h] of [[1920, 1080], [1919, 1079], [1280, 720]]) {
      assert.deepEqual(
        proto.planeLayout(key, w, h),
        wire.planeLayout(key, w, h),
        `${key} planeLayout 漂移 @${w}x${h}`
      );
    }
    // frameSize 与 wire 的 plane 字节和一致
    const layout = wire.planeLayout(key, 1920, 1080);
    assert.equal(proto.frameSize(key, 1920, 1080), layout.reduce((s, p) => s + p.bytes, 0), `${key} frameSize 漂移`);
  }
});
