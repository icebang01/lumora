'use strict';
// voice 标签往返一致性：主进程 protocol.js（CJS）writeHeader 写入的声部标签，
// 必须被渲染端 wire.js（ESM）readHeader 精确还原。wire.js 是浏览器 ESM，
// Node 按 CJS 解析 .js 会炸 export —— 复制为 .mjs 后动态导入。
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

test('Voice 常量双份一致（PRIMARY=0 / SECONDARY=1）', () => {
  assert.deepEqual(
    { p: proto.Voice.PRIMARY, s: proto.Voice.SECONDARY },
    { p: wire.Voice.PRIMARY, s: wire.Voice.SECONDARY },
    'protocol.Voice 与 wire.Voice 不一致'
  );
  assert.equal(proto.Voice.PRIMARY, 0, 'PRIMARY 必须为 0（默认声部）');
  assert.equal(proto.Voice.SECONDARY, 1, 'SECONDARY 必须为 1（交叉淡入淡出副声部）');
});

test('voice=0 时包头 offset 2-3 仍等效旧保留字节（向后兼容）', () => {
  const buf = Buffer.allocUnsafe(proto.HEADER_SIZE);
  proto.writeHeader(buf, { type: proto.PacketType.AUDIO, seq: 1, pts: 0.5, epoch: 7, voice: 0 });
  // 旧格式用 writeUInt16LE(0, 2) 写保留字节；voice=0 时 byte2=0,byte3=0，完全等价
  assert.equal(buf.readUInt16LE(2), 0, 'voice=0 时 offset 2-3 必须为 0（兼容旧渲染端）');
  assert.equal(buf.byteLength, proto.HEADER_SIZE, '包头大小不变（仍为 32 字节）');
});

test('voice 标签在 protocol 写入 → wire 读出 往返一致', () => {
  for (const voice of [proto.Voice.PRIMARY, proto.Voice.SECONDARY]) {
    const buf = Buffer.allocUnsafe(proto.HEADER_SIZE);
    proto.writeHeader(buf, {
      type: proto.PacketType.AUDIO,
      seq: 42,
      pts: 12.34,
      epoch: 9,
      voice,
    });
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const h = wire.readHeader(view);
    assert.equal(h.voice, voice, `voice=${voice} 往返不一致`);
    // 其余字段不受影响
    assert.equal(h.type, proto.PacketType.AUDIO);
    assert.equal(h.seq, 42);
    assert.equal(h.pts, 12.34);
    assert.equal(h.epoch, 9);
  }
});

test('voice 写入高位字节（offset 3）仍保留为 0，不影响 voice 解析', () => {
  const buf = Buffer.allocUnsafe(proto.HEADER_SIZE);
  proto.writeHeader(buf, { type: proto.PacketType.AUDIO, voice: 1 });
  assert.equal(buf.readUInt8(2), 1, 'voice 应写入 offset 2');
  assert.equal(buf.readUInt8(3), 0, 'offset 3 保留字节必须为 0');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(wire.readHeader(view).voice, 1);
});
