'use strict';
// 显示色彩管理（block #4c）色彩科学单测：
//  - 标准色域矩阵：sRGB/同色域 → 单位阵（向后兼容、零视觉变化）
//  - 'auto' / 未知 id → null（调用方回退 sRGB）
//  - 广色域(P3)矩阵非空且保留白点（白→白不变）
//  - EDID 实测色度 → 可解析为矩阵
//  - ICC 文件解析：合成一个描述 sRGB 的最小 ICC，解析后应为单位阵（验证标签读取 + 合成）
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let dp;
before(async () => {
  const src = path.join(__dirname, '..', '..', 'src', 'renderer', 'gl', 'display-profile.js');
  const tmp = path.join(os.tmpdir(), `display-profile-${process.pid}.mjs`);
  fs.copyFileSync(src, tmp);
  dp = await import(pathToFileURL(tmp).href);
});

// 直接通过动态导入的模块对象取导出（ESM 模块在 commonjs 工程下需 .mjs 副本）
function exps() {
  return dp;
}

test('resolveGamutMatrix(srgb) ≈ 单位阵', () => {
  const m = exps().resolveGamutMatrix('srgb');
  assert.ok(m && m.length === 9, '应返回长度 9 的列主序矩阵');
  for (let i = 0; i < 9; i++) {
    const expect = (i % 4 === 0) ? 1 : 0; // 对角 1，其余 0
    assert.ok(Math.abs(m[i] - expect) < 1e-4, `元素 ${i} 偏差过大: ${m[i]}`);
  }
});

test('resolveGamutMatrix(bt709) ≈ 单位阵（与 sRGB 共享原色）', () => {
  const m = exps().resolveGamutMatrix('bt709');
  for (let i = 0; i < 9; i++) {
    const expect = (i % 4 === 0) ? 1 : 0;
    assert.ok(Math.abs(m[i] - expect) < 1e-4, `元素 ${i} 偏差过大: ${m[i]}`);
  }
});

test("resolveGamutMatrix('auto') 自动探测显示器色域（无 window 兜底 srgb）", () => {
  // 自动模式现在会调用 detectDisplayGamut() 探测显示器能力并返回对应矩阵，
  // 不再是 null（null 是未知 id 的兜底）。无头环境下 window 未定义 → 兜底 srgb 矩阵。
  const m = exps().resolveGamutMatrix('auto');
  assert.ok(m && m.length === 9, 'auto 应返回探测到的色域矩阵，而非 null');
  // 验证 detectDisplayGamut 导出存在且行为合理
  assert.strictEqual(typeof exps().detectDisplayGamut, 'function');
  const g = exps().detectDisplayGamut();
  assert.ok(['bt2020', 'display-p3', 'srgb'].includes(g), 'detectDisplayGamut 应返回已知色域 id');
});

test('resolveGamutMatrix(未知 id) 返回 null', () => {
  assert.strictEqual(exps().resolveGamutMatrix('nonsense'), null);
});

test('广色域(P3)矩阵：非空且白点守恒', () => {
  const m = exps().resolveGamutMatrix('display-p3');
  assert.ok(m && m.length === 9);
  // 至少若干非对角元偏离 0（确实做了色域换算）
  let offDiag = 0;
  for (let i = 0; i < 9; i++) if (i % 4 !== 0 && Math.abs(m[i]) > 1e-3) offDiag++;
  assert.ok(offDiag > 0, 'P3 矩阵不应是单位阵');
  // 白点(1,1,1)在同白点(D65)适配下应映射回 (≈1,1,1)
  const w = exps().applyColMajor(m, [1, 1, 1]);
  for (const c of w) assert.ok(Math.abs(c - 1) < 1e-3, `白点映射偏差: ${c}`);
});

test('edidPrimaries + custom：合成 sRGB 实测 → 单位阵', () => {
  const ch = {
    red: { x: 0.6400, y: 0.3300 },
    green: { x: 0.3000, y: 0.6000 },
    blue: { x: 0.1500, y: 0.0600 },
    white: { x: 0.3127, y: 0.3290 },
  };
  const prim = exps().edidPrimaries(ch);
  const m = exps().resolveGamutMatrix('custom', prim);
  for (let i = 0; i < 9; i++) {
    const expect = (i % 4 === 0) ? 1 : 0;
    assert.ok(Math.abs(m[i] - expect) < 1e-3, `元素 ${i} 偏差过大: ${m[i]}`);
  }
});

/* ---------- ICC 合成解析 ---------- */

function writeBE32(buf, off, val) {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}
function writeS15(buf, off, val) {
  // 有符号 15.16 定点；值较小且为正，用无符号编码等价
  let v = Math.round(val * 65536);
  v = v & 0xffffffff;
  writeBE32(buf, off, v >>> 0);
}

function buildSyntheticICC() {
  // 用模块自身算出的 sRGB 原色 XYZ + D65 白点，构造一个最小矩阵型 ICC。
  const M = exps().primToXYZmat(exps().GAMUTS.srgb); // 行主序 RGB→XYZ
  const rXYZ = [M[0], M[3], M[6]];
  const gXYZ = [M[1], M[4], M[7]];
  const bXYZ = [M[2], M[5], M[8]];
  const wXYZ = exps().xyToXYZ(exps().GAMUTS.srgb.w);

  const TAGS = [
    ['rXYZ', rXYZ], ['gXYZ', gXYZ], ['bXYZ', bXYZ], ['wtpt', wXYZ],
  ];
  const HEAD = 128;
  const countOff = HEAD;
  const tableOff = HEAD + 4;
  const entrySize = 12;
  const dataStart = tableOff + TAGS.length * entrySize;
  const tagDataSize = 20; // 'XYZ '(4) + reserved(4) + 3×s15(12)
  const total = dataStart + TAGS.length * tagDataSize;

  const buf = Buffer.alloc(total);
  writeBE32(buf, 0, total);            // profile size
  buf.write('acsp', 36, 'ascii');     // signature
  writeBE32(buf, countOff, TAGS.length);
  let dataOff = dataStart;
  TAGS.forEach(([sig, xyz], i) => {
    const e = tableOff + i * entrySize;
    buf.write(sig, e, 'ascii');
    writeBE32(buf, e + 4, dataOff);
    writeBE32(buf, e + 8, tagDataSize);
    buf.write('XYZ ', dataOff, 'ascii');
    writeS15(buf, dataOff + 8, xyz[0]);
    writeS15(buf, dataOff + 12, xyz[1]);
    writeS15(buf, dataOff + 16, xyz[2]);
    dataOff += tagDataSize;
  });
  return new Uint8Array(buf);
}

test('parseICCProfile：合成 sRGB ICC → 单位阵', () => {
  const buf = buildSyntheticICC();
  const { matrix, primaries } = exps().parseICCProfile(buf);
  assert.ok(matrix && matrix.length === 9);
  for (let i = 0; i < 9; i++) {
    const expect = (i % 4 === 0) ? 1 : 0;
    assert.ok(Math.abs(matrix[i] - expect) < 1e-2, `ICC 元素 ${i} 偏差过大: ${matrix[i]}`);
  }
  assert.ok(primaries && primaries.r && primaries.w, '应回带 primaries');
});

test('parseICCProfile：非矩阵型/损坏 → 抛错', () => {
  assert.throws(() => exps().parseICCProfile(new Uint8Array(10)), /too small|bad/);
  // 缺色度标签的 ICC（只放 wtpt）
  const buf = Buffer.alloc(128 + 4 + 12 + 20);
  writeBE32(buf, 0, buf.length);
  buf.write('acsp', 36, 'ascii');
  writeBE32(buf, 128, 1);
  buf.write('wtpt', 132, 'ascii');
  writeBE32(buf, 136, 128 + 4 + 12);
  writeBE32(buf, 140, 20);
  buf.write('XYZ ', 128 + 4 + 12, 'ascii');
  assert.throws(() => exps().parseICCProfile(new Uint8Array(buf)), /not a matrix/);
});
