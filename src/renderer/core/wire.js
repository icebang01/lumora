/**
 * 协议解析（渲染进程侧，ESM）。
 *
 * ⚠ 这里的常量必须与 src/shared/protocol.js 保持一致 —— 主进程是
 * CommonJS、渲染进程是 ESM，无法直接共享同一份模块，所以字段布局
 * 在两边各写一次。改动协议时两边都要改。
 *
 * 平面描述符形状（planes 里每项 {key, wDiv, hDiv}）刻意与 protocol.js
 * 保持一致，使两份表可被自动化一致性测试逐项比对，防止日后漂移。
 */

export const HEADER_SIZE = 32;

export const PacketType = {
  VIDEO: 1,
  AUDIO: 2,
  EOS: 3,
  FLUSH: 4,
  META: 5,
};

/** 声部标签，与 src/shared/protocol.js 的 Voice 保持一致 */
export const Voice = {
  PRIMARY: 0,
  SECONDARY: 1,
};

export function readHeader(view) {
  return {
    type: view.getUint8(0),
    flags: view.getUint8(1),
    voice: view.getUint8(2),
    seq: view.getUint32(4, true),
    pts: view.getFloat64(8, true),
    epoch: view.getUint32(16, true),
    a: view.getUint32(20, true),
    b: view.getUint32(24, true),
    c: view.getUint32(28, true),
  };
}

/** 平面描述符：与 protocol.js 完全同形（{key, wDiv, hDiv}）以便于一致性测试 */
export const PixelFormats = {
  yuv420p:     { bytesPerSample: 1, bitDepth: 8,  planes: [{ key: 'y', wDiv: 1, hDiv: 1 }, { key: 'u', wDiv: 2, hDiv: 2 }, { key: 'v', wDiv: 2, hDiv: 2 }] },
  yuv422p:     { bytesPerSample: 1, bitDepth: 8,  planes: [{ key: 'y', wDiv: 1, hDiv: 1 }, { key: 'u', wDiv: 2, hDiv: 1 }, { key: 'v', wDiv: 2, hDiv: 1 }] },
  yuv444p:     { bytesPerSample: 1, bitDepth: 8,  planes: [{ key: 'y', wDiv: 1, hDiv: 1 }, { key: 'u', wDiv: 1, hDiv: 1 }, { key: 'v', wDiv: 1, hDiv: 1 }] },
  yuv420p10le: { bytesPerSample: 2, bitDepth: 10, planes: [{ key: 'y', wDiv: 1, hDiv: 1 }, { key: 'u', wDiv: 2, hDiv: 2 }, { key: 'v', wDiv: 2, hDiv: 2 }] },
  yuv422p10le: { bytesPerSample: 2, bitDepth: 10, planes: [{ key: 'y', wDiv: 1, hDiv: 1 }, { key: 'u', wDiv: 2, hDiv: 1 }, { key: 'v', wDiv: 2, hDiv: 1 }] },
  yuv444p10le: { bytesPerSample: 2, bitDepth: 10, planes: [{ key: 'y', wDiv: 1, hDiv: 1 }, { key: 'u', wDiv: 1, hDiv: 1 }, { key: 'v', wDiv: 1, hDiv: 1 }] },
};

/**
 * 计算 Y/U/V 三个平面在帧缓冲中的位置，渲染端据此做零拷贝 subarray。
 * 平面描述符改为 {key, wDiv, hDiv} 后，循环从 p.wDiv/p.hDiv 读取，
 * 输出形状（{key, width, height, offset, bytes}）与旧版逐字节一致。
 */
export function planeLayout(pixfmt, width, height) {
  const fmt = PixelFormats[pixfmt] || PixelFormats.yuv420p;
  const out = [];
  let offset = 0;
  for (const p of fmt.planes) {
    const w = Math.ceil(width / p.wDiv);
    const h = Math.ceil(height / p.hDiv);
    const bytes = w * h * fmt.bytesPerSample;
    out.push({ key: p.key, width: w, height: h, offset, bytes });
    offset += bytes;
  }
  return out;
}
