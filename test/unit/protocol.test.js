'use strict';
// 共享协议层单测：PacketType 常量、帧头往返、像素格式换算。
const { test } = require('node:test');
const assert = require('node:assert');
const proto = require('../../src/shared/protocol');

test('PacketType 常量唯一且为预期值', () => {
  assert.deepEqual(proto.PacketType, { VIDEO: 1, AUDIO: 2, EOS: 3, FLUSH: 4, META: 5 });
  const vals = Object.values(proto.PacketType);
  assert.equal(new Set(vals).size, vals.length, '值必须唯一');
});

test('writeHeader → readHeader 往返保真', () => {
  const buf = Buffer.alloc(64);
  proto.writeHeader(buf, { type: 3, flags: 1, seq: 42, pts: 123456789, epoch: 7 });
  const h = proto.readHeader(new DataView(buf.buffer, buf.byteOffset, 64));
  assert.equal(h.type, 3);
  assert.equal(h.flags, 1);
  assert.equal(h.seq, 42);
  assert.equal(h.pts, 123456789);
  assert.equal(h.epoch, 7);
});

test('writeHeader 默认值（flags/seq/pts/epoch 缺省为 0）', () => {
  const buf = Buffer.alloc(64);
  proto.writeHeader(buf, { type: 1 });
  const h = proto.readHeader(new DataView(buf.buffer, buf.byteOffset, 64));
  assert.equal(h.type, 1);
  assert.equal(h.flags, 0);
  assert.equal(h.seq, 0);
  assert.equal(h.pts, 0);
  assert.equal(h.epoch, 0);
});

test('normalizePixFmt：nv12/常见别名归一化', () => {
  assert.equal(proto.normalizePixFmt('nv12', 8), 'yuv420p');
});

test('frameSize：yuv420p 4:2:0 = w*h*3/2', () => {
  const size = proto.frameSize('yuv420p', 1920, 1080);
  assert.equal(size, Math.floor((1920 * 1080 * 3) / 2));
});

test('frameSize：未知格式抛错（契约明确）', () => {
  assert.throws(() => proto.frameSize('nv12', 1920, 1080), /unsupported pixel format/);
});
