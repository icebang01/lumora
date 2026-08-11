/**
 * 显示色彩管理 —— 色彩科学部分（纯 JS，可在 node 下单测）。
 *
 * 问题背景：
 *   渲染管线 Pass A 输出的是「线性光 + BT.709 原色」的 RGB，Pass B 再
 *   用 sRGB 的 OETF 编码进帧缓冲。它**默认显示器就是 sRGB/BT.709**。
 *   但在广色域显示器（Display-P3 / AdobeRGB / BT.2020，如今很常见）上，
 *   操作系统把窗口当成 sRGB 解读，于是为 sRGB 制作的内容被直接投进更
 *   宽的色域 → 颜色过饱和、不准确。
 *
 * 解法（与 mpv --icc-profile 对真实显示器做的完全一致）：
 *   把「规范空间(BT.709 线性)」的图像，经过**色适应 + 原色矩阵**换算到
 *   **显示器实际的色域**，再交给 sRGB 的 OETF 编码。这种「把显示器
 *   配置文件嵌入输出」的技巧，正是浏览器 / mpv 做色彩管理的核心。
 *   当目标色域 == sRGB 时矩阵为单位阵 → 输出与改动前逐比特一致（向后兼容）。
 *
 * 所有矩阵运算都在线性光域、行主序表达；最后 packColMajor 转成
 * GLSL mat3 期望的列主序（与 renderer.js 既有的矩阵约定一致）。
 */

/* ============================ 矩阵小工具（行主序 3x3） ============================ */

function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] =
        a[r * 3 + 0] * b[0 * 3 + c] +
        a[r * 3 + 1] * b[1 * 3 + c] +
        a[r * 3 + 2] * b[2 * 3 + c];
    }
  }
  return o;
}

function mulMV(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function transpose3(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function diag(s) {
  return [s[0], 0, 0, 0, s[1], 0, 0, 0, s[2]];
}

/** 3x3 求逆（高斯消元）。奇异时抛错，由调用方兜底。 */
function inv3(m) {
  const a = m.slice();
  const inv = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let col = 0; col < 3; col++) {
    // 选主元
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r * 3 + col]) > Math.abs(a[piv * 3 + col])) piv = r;
    }
    if (Math.abs(a[piv * 3 + col]) < 1e-12) throw new Error('singular matrix');
    if (piv !== col) {
      for (let k = 0; k < 3; k++) {
        [a[col * 3 + k], a[piv * 3 + k]] = [a[piv * 3 + k], a[col * 3 + k]];
        [inv[col * 3 + k], inv[piv * 3 + k]] = [inv[piv * 3 + k], inv[col * 3 + k]];
      }
    }
    const d = a[col * 3 + col];
    for (let k = 0; k < 3; k++) {
      a[col * 3 + k] /= d;
      inv[col * 3 + k] /= d;
    }
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r * 3 + col];
      if (f === 0) continue;
      for (let k = 0; k < 3; k++) {
        a[r * 3 + k] -= f * a[col * 3 + k];
        inv[r * 3 + k] -= f * inv[col * 3 + k];
      }
    }
  }
  return inv;
}

/** 行主序 → 列主序（GLSL mat3 / uniformMatrix3fv 期望）。 */
function packColMajor(rowMajor) {
  return new Float32Array(transpose3(rowMajor));
}

/* ============================ 色度学 ============================ */

/**
 * CIE xy 色度坐标 → XYZ（Y 归一化为 1）。
 * 由 x = X/(X+Y+Z), y = Y/(X+Y+Z) 反推：Y=1 → X=x/y, Z=(1-x-y)/y。
 */
function xyToXYZ(xy) {
  const y = xy[1];
  if (Math.abs(y) < 1e-9) return [0, 0, 0];
  return [xy[0] / y, 1, (1 - xy[0] - y) / y];
}

/**
 * 由一组原色(红/绿/蓝/白 的 xy)构造「线性 RGB → XYZ」矩阵（行主序）。
 * 标准做法：原色本身是 RGB→XYZ 的各列，再按白点解出每通道缩放系数。
 */
function primToXYZmat(p) {
  const Xr = p.r[0] / p.r[1], Zr = (1 - p.r[0] - p.r[1]) / p.r[1];
  const Xg = p.g[0] / p.g[1], Zg = (1 - p.g[0] - p.g[1]) / p.g[1];
  const Xb = p.b[0] / p.b[1], Zb = (1 - p.b[0] - p.b[1]) / p.b[1];
  // 列 = 原色：A = [[Xr,Xg,Xb],[Yr,Yg,Yb],[Zr,Zg,Zb]]
  const A = [Xr, Xg, Xb, 1, 1, 1, Zr, Zg, Zb];
  const W = xyToXYZ(p.w);
  const S = solve3(A, W); // [Sr, Sg, Sb]
  // M(RGB→XYZ)：第 k 行 = Sk * 原色第 k 行分量
  return [
    S[0] * Xr, S[1] * Xg, S[2] * Xb,
    S[0] * 1,  S[1] * 1,  S[2] * 1,
    S[0] * Zr, S[1] * Zg, S[2] * Zb,
  ];
}

/** 解 3x3 线性方程组 A·x = b（高斯消元，与 inv3 同思路但只算一列）。 */
function solve3(A, b) {
  const m = [
    A[0], A[1], A[2], b[0],
    A[3], A[4], A[5], b[1],
    A[6], A[7], A[8], b[2],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r * 4 + col]) > Math.abs(m[piv * 4 + col])) piv = r;
    }
    if (Math.abs(m[piv * 4 + col]) < 1e-12) throw new Error('singular matrix');
    if (piv !== col) {
      for (let k = 0; k < 4; k++) {
        [m[col * 4 + k], m[piv * 4 + k]] = [m[piv * 4 + k], m[col * 4 + k]];
      }
    }
    const d = m[col * 4 + col];
    for (let k = 0; k < 4; k++) m[col * 4 + k] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r * 4 + col];
      if (f === 0) continue;
      for (let k = 0; k < 4; k++) m[r * 4 + k] -= f * m[col * 4 + k];
    }
  }
  return [m[3], m[7], m[11]];
}

/* ---------- Bradford 色适应（D65→D50 等白点迁移） ---------- */

// Bradford 锥细胞响应矩阵（CIECAM02 之前的经典适配，ICC 普遍采用）
const BRADFORD_M = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
];

function bradford(srcXYZ, dstXYZ) {
  const sc = mulMV(BRADFORD_M, srcXYZ);
  const dc = mulMV(BRADFORD_M, dstXYZ);
  const scale = [dc[0] / sc[0], dc[1] / sc[1], dc[2] / sc[2]];
  // M = M^-1 · diag(scale) · M
  return mul3(mul3(inv3(BRADFORD_M), diag(scale)), BRADFORD_M);
}

/* ============================ 标准色域表 ============================ */

// 全部为 CIE 1931 xy 色度坐标；白点除特别说明外均为 D65。
const GAMUTS = {
  // BT.709 / sRGB 共享同一组原色与 D65 白点
  'bt709': {
    r: [0.6400, 0.3300], g: [0.3000, 0.6000], b: [0.1500, 0.0600], w: [0.3127, 0.3290],
  },
  'srgb': {
    r: [0.6400, 0.3300], g: [0.3000, 0.6000], b: [0.1500, 0.0600], w: [0.3127, 0.3290],
  },
  // Display-P3：原色取自 DCI-P3，白点改 D65（与 sRGB 一致的观看白）
  'display-p3': {
    r: [0.6800, 0.3200], g: [0.2650, 0.6900], b: [0.1500, 0.0600], w: [0.3127, 0.3290],
  },
  // AdobeRGB 1998
  'adobe-rgb': {
    r: [0.6400, 0.3300], g: [0.2100, 0.7100], b: [0.1500, 0.0600], w: [0.3127, 0.3290],
  },
  // BT.2020（UHDTV）
  'bt2020': {
    r: [0.7080, 0.2920], g: [0.1700, 0.7970], b: [0.1310, 0.0460], w: [0.3127, 0.3290],
  },
};

/** 规范工作空间：管线 Pass A 输出的原色永远是 BT.709 线性。 */
export const CANONICAL_GAMUT = 'bt709';

/**
 * 合成「规范空间 → 目标色域」的转换矩阵（行主序）。
 *   M = M_dst^-1 · Bradford(Wcanon→Wdst) · M_src
 * 当 src==dst（同原色同白点）时为单位阵。
 */
export function composeDisplayMatrix(srcPrim, dstPrim) {
  const Msrc = primToXYZmat(srcPrim);          // RGB_src → XYZ
  const MinvDst = inv3(primToXYZmat(dstPrim)); // XYZ → RGB_dst
  const adapt = bradford(xyToXYZ(srcPrim.w), xyToXYZ(dstPrim.w)); // XYZ → XYZ
  return mul3(mul3(MinvDst, adapt), Msrc);      // RGB_src → RGB_dst
}

/**
 * 按配置 id 解析显示矩阵（列主序 Float32Array，可直接喂 uniformMatrix3fv）。
 *   - 'auto' 返回 null：调用方应在拿到 EDID/ICC 实测结果后再 setDisplayMatrix，
 *     否则回退到单位阵（按 sRGB 假设，与改动前行为一致）。
 *   - 'srgb'/'bt709' 等单位阵，保证向后兼容、零视觉变化。
 *   - 'custom' 需要传入 primaries（来自 ICC 文件解析）。
 */
export function resolveGamutMatrix(id, custom = null) {
  if (id === 'auto') return resolveGamutMatrix(detectDisplayGamut());
  if (id === 'custom') {
    if (!custom) return null;
    return packColMajor(composeDisplayMatrix(GAMUTS[CANONICAL_GAMUT], custom));
  }
  const dst = GAMUTS[id];
  if (!dst) return null;
  return packColMajor(composeDisplayMatrix(GAMUTS[CANONICAL_GAMUT], dst));
}

/**
 * 自动探测显示器色彩能力（HDR / 广色域），返回应使用的目标色域 id。
 * 基于标准 CSS 媒体查询（Chromium/Electron 支持）：
 *   (dynamic-range: high)  —— OS+HDR 显示器（Windows HDR 模式 / macOS EDR）
 *   (color-gamut: rec2020)  —— 能显示 BT.2020 的显示器
 *   (color-gamut: p3)       —— 能显示 Display-P3 的显示器
 * 返回：'bt2020'（真 HDR 显示，保留广色域）| 'display-p3' | 'srgb'（兜底）
 *
 * 这是"自动识别 HDR"的关键一环：源文件 HDR 类型已由 ffprobe 自动探测，
 * 此处自动探测显示端能力 → 色调映射自动瞄准正确目标色域，无需手动配置。
 */
export function detectDisplayGamut() {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return 'srgb';
    const mq = (q) => { try { return window.matchMedia(q).matches; } catch { return false; } };
    if (mq('(dynamic-range: high)') && mq('(color-gamut: rec2020)')) return 'bt2020';
    if (mq('(color-gamut: p3)')) return 'display-p3';
    return 'srgb';
  } catch {
    return 'srgb';
  }
}

export function hasGamut(id) {
  return id === 'auto' || id === 'custom' || !!GAMUTS[id];
}

/* ============================ EDID 实测色度 ============================ */

/**
 * 由 EDID/WMI 读到的「分数制 xy」（WmiMonitorColorCharacteristics 已归一化到 0..1）
 * 拼成 primaries 对象，供 resolveGamutMatrix('custom', primaries) 使用。
 * 输入示例：{ red:{x,y}, green:{x,y}, blue:{x,y}, white:{x,y} }
 */
export function edidPrimaries(ch) {
  return {
    r: [ch.red.x, ch.red.y],
    g: [ch.green.x, ch.green.y],
    b: [ch.blue.x, ch.blue.y],
    w: [ch.white.x, ch.white.y],
  };
}

/* ============================ ICC 配置文件解析 ============================ */

function readUint32BE(buf, off) {
  return (
    ((buf[off] & 0xff) << 24) |
    ((buf[off + 1] & 0xff) << 16) |
    ((buf[off + 2] & 0xff) << 8) |
    (buf[off + 3] & 0xff)
  ) >>> 0;
}

function readInt32BE(buf, off) {
  const u = readUint32BE(buf, off);
  return u >= 0x80000000 ? u - 0x100000000 : u;
}

/** s15Fixed16 解码（有符号 15.16 定点）。 */
function readS15Fixed16(buf, off) {
  return readInt32BE(buf, off) / 65536;
}

function readTagASCII(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

/**
 * 解析矩阵/TRC 类 ICC 显示器配置文件，产出「规范空间 → 该显示器色域」的转换矩阵。
 *
 * 显示器配置文件的 rXYZ/gXYZ/bXYZ 标签给出每个原色的 XYZ（即 RGB=(1,0,0) 时的
 * 三刺激值），wtpt 给出 PCS 白点（通常是 D50）。我们据此：
 *   M_disp(RGB→XYZ) 由三个原色 XYZ 直接拼出 → 反解出 RGB_disp；
 *   把规范空间(BT.709/D65) 经 Bradford 适配到 PCS 白点(D50)，再投到 RGB_disp。
 *
 * 仅支持矩阵/TRC 型（绝大多数显示器 ICC 配置均为此类）。LUT 型（A2B/B2A）
 * 需要 3D LUT 采样，留作后续增强，这里抛错交由调用方回退 sRGB。
 *
 * @param {Uint8Array} buf ICC 文件字节
 * @returns {{matrix: Float32Array, primaries: object}}
 */
export function parseICCProfile(buf) {
  if (!buf || buf.length < 132) throw new Error('icc: buffer too small');
  const size = readUint32BE(buf, 0);
  if (size > buf.length || size < 132) throw new Error('icc: bad profile size');
  // bytes 36..39 应为 'acsp'
  if (readTagASCII(buf, 36) !== 'acsp') throw new Error('icc: missing acsp signature');

  const count = readUint32BE(buf, 128);
  if (count <= 0 || count > 100) throw new Error('icc: bad tag count');

  const want = { rXYZ: null, gXYZ: null, bXYZ: null, wtpt: null };
  for (let i = 0; i < count; i++) {
    const e = 132 + i * 12;
    const sig = readTagASCII(buf, e);
    const off = readUint32BE(buf, e + 4);
    if (sig in want) want[sig] = off;
  }
  if (!want.rXYZ || !want.gXYZ || !want.bXYZ || !want.wtpt) {
    throw new Error('icc: not a matrix/TRC profile (missing colorant tags)');
  }

  const xyz = (off) => [
    readS15Fixed16(buf, off + 8),
    readS15Fixed16(buf, off + 12),
    readS15Fixed16(buf, off + 16),
  ];
  const R = xyz(want.rXYZ);
  const G = xyz(want.gXYZ);
  const B = xyz(want.bXYZ);
  const W = xyz(want.wtpt);

  // M_disp(RGB→XYZ) 行主序：列 = 各原色 XYZ
  const Mdisp = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const MinvDisp = inv3(Mdisp);
  const adapt = bradford(xyToXYZ(GAMUTS[CANONICAL_GAMUT].w), xyToXYZ(xyzToXY(W)));
  const Msrc = primToXYZmat(GAMUTS[CANONICAL_GAMUT]);
  const M = mul3(mul3(MinvDisp, adapt), Msrc);

  return {
    matrix: packColMajor(M),
    primaries: {
      r: xyFromXYZ(R), g: xyFromXYZ(G), b: xyFromXYZ(B), w: xyFromXYZ(W),
    },
  };
}

function xyFromXYZ(XYZ) {
  const s = XYZ[0] + XYZ[1] + XYZ[2];
  if (s < 1e-9) return [0, 0];
  return [XYZ[0] / s, XYZ[1] / s];
}

function xyzToXY(XYZ) {
  return xyFromXYZ(XYZ);
}

/* ============================ 调试辅助（供单测 / 自检） ============================ */

/** 把列主序矩阵当成行主序那样乘以向量（单测里验证合成结果用）。 */
export function applyColMajor(mat, v) {
  const M = transpose3(Array.from(mat));
  return mulMV(M, v);
}

export { GAMUTS, xyToXYZ, primToXYZmat, bradford, packColMajor };
