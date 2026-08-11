'use strict';
// 弹幕/字幕匹配用电影哈希单测（mpv movie hash）。
// subtitles.js 顶层 require('electron')，单测用 Module._load mock 掉；
// node:test 每个文件独立进程，mock 不会泄漏到其他测试。
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let computeMovieHash;
let f1, f2;
before(() => {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
    return origLoad.call(this, request, parent, isMain);
  };
  ({ computeMovieHash } = require('../../src/main/subtitles'));

  // 确定性夹具：≥64KB（尾部读取位置 size-65536 必须 ≥0），内容可复现
  const content = Buffer.alloc(70000);
  for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) % 251;
  content.write('Lumora-HASH-GOLDEN', 1000);
  f1 = path.join(os.tmpdir(), `lumina-hash-${process.pid}-1.bin`);
  f2 = path.join(os.tmpdir(), `lumina-hash-${process.pid}-2.bin`);
  fs.writeFileSync(f1, content);
  fs.writeFileSync(f2, Buffer.concat([content, Buffer.from('X')]));
});

test('computeMovieHash：黄金值（内容+尺寸固定 → 哈希固定）', () => {
  assert.equal(computeMovieHash(f1), '39dec29a3b026810');
});

test('computeMovieHash：确定性（同文件两次一致）', () => {
  assert.equal(computeMovieHash(f1), computeMovieHash(f1));
});

test('computeMovieHash：对内容/尺寸敏感', () => {
  assert.notEqual(computeMovieHash(f2), computeMovieHash(f1));
});

test('computeMovieHash：小文件/不存在文件返回 null（不抛）', () => {
  assert.equal(computeMovieHash(path.join(os.tmpdir(), 'no-such-file.bin')), null);
});
