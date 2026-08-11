// @ts-check
'use strict';
/**
 * Lumora 媒体传输协议
 *
 * 视频/音频裸流不走 Electron IPC —— 结构化克隆对 90MB/s 级别的裸 YUV
 * 数据是灾难。改走本地 WebSocket(127.0.0.1)，loopback 上 ws 能跑到 GB/s，
 * 且自带背压（bufferedAmount），正好用来做解码节流。
 *
 * 每个包 = 32 字节定长头 + 载荷。头部定长是为了让渲染进程能用
 * DataView 零分配解析，避免每帧产生临时对象。
 *
 *  offset  size  field
 *  ------  ----  -----------------------------------------------
 *   0      1     type      1=video 2=audio 3=eos 4=flush 5=meta
 *   1      1     flags     bit0=keyframe bit1=seek-anchor
 *   2      1     voice     声部标签：0=主声部(A) 1=淡入淡出副声部(B)
 *   3      1     -         保留（对齐）
 *   4      4     seq       u32 序号，用于检测丢包与 seek 代际
 *   8      8     pts       f64 显示时间戳（秒）
 *  16      4     epoch     u32 代际号，seek 后自增，丢弃旧代际数据
 *  20      4     w / nb    视频=宽，音频=采样帧数
 *  24      4     h / rate  视频=高，音频=采样率
 *  28      4     stride/ch 视频=Y平面行宽，音频=声道数
 *  32      ..    payload
 *
 *  voice 标签占用原"保留(2字节)"中的 1 字节，包总大小不变（仍是 32B）。
 *  渲染端据此把音频路由到不同的声部节点（交叉淡入淡出时需要同时
 *  解码旧曲尾 + 新曲头并各自独立混音）。无交叉淡入淡出时恒为 0。
 */

const HEADER_SIZE = 32;

const PacketType = {
  VIDEO: 1,
  AUDIO: 2,
  EOS: 3,
  FLUSH: 4,
  META: 5,
};

const Flags = {
  KEYFRAME: 1 << 0,
  SEEK_ANCHOR: 1 << 1,
};

/**
 * 声部标签（写入包头 offset 2）。交叉淡入淡出时主进程会同时跑两条
 * 音频管线，旧曲尾标记为 PRIMARY（仍在播放），新曲头标记为 SECONDARY
 * （正在淡入），渲染端据此把两路 PCM 路由到各自独立的增益斜坡声部。
 * 正常播放恒为 PRIMARY。
 */
const Voice = {
  PRIMARY: 0,
  SECONDARY: 1,
};

/**
 * 写入包头。复用调用方传入的 Buffer，不做分配。
 * @param {Buffer} buf
 * @param {PacketHeaderOptions} opts
 * @returns {Buffer}
 */
function writeHeader(buf, { type, flags = 0, voice = 0, seq = 0, pts = 0, epoch = 0, a = 0, b = 0, c = 0 }) {
  buf.writeUInt8(type, 0);
  buf.writeUInt8(flags, 1);
  buf.writeUInt8(voice & 0xff, 2);   // 声部标签（交叉淡入淡出副声部 = 1）
  buf.writeUInt8(0, 3);              // 保留（对齐）
  buf.writeUInt32LE(seq >>> 0, 4);
  buf.writeDoubleLE(pts, 8);
  buf.writeUInt32LE(epoch >>> 0, 16);
  buf.writeUInt32LE(a >>> 0, 20);
  buf.writeUInt32LE(b >>> 0, 24);
  buf.writeUInt32LE(c >>> 0, 28);
  return buf;
}

/**
 * 从 ArrayBuffer 解析包头（渲染进程侧使用，DataView 零分配）。
 * @param {DataView} view
 * @returns {PacketHeader}
 */
function readHeader(view) {
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

/**
 * 像素格式描述表。
 * 决定 ffmpeg 输出什么、渲染进程怎么切平面、WebGL 用什么纹理格式。
 * @param {string} name
 * @param {number} bytesPerSample
 * @param {number} bitDepth
 * @param {number} wDiv
 * @param {number} hDiv
 * @returns {PixFmtInfo}
 */
function planarYUV(name, bytesPerSample, bitDepth, wDiv, hDiv) {
  return {
    name,
    bytesPerSample,
    bitDepth,
    planes: [
      { key: 'y', wDiv: 1, hDiv: 1 },
      { key: 'u', wDiv, hDiv },
      { key: 'v', wDiv, hDiv },
    ],
  };
}

const PixelFormats = {
  yuv420p: planarYUV('yuv420p', 1, 8, 2, 2),
  yuv422p: planarYUV('yuv422p', 1, 8, 2, 1),
  yuv444p: planarYUV('yuv444p', 1, 8, 1, 1),
  yuv420p10le: planarYUV('yuv420p10le', 2, 10, 2, 2),
  yuv422p10le: planarYUV('yuv422p10le', 2, 10, 2, 1),
  yuv444p10le: planarYUV('yuv444p10le', 2, 10, 1, 1),
};

/**
 * 把源像素格式收敛到管线支持的那几种。
 *
 * 真实世界的片子什么格式都有：nv12、p010、yuvj420p、gbrp、12bit、
 * 甚至 gray。全部原样透传是不现实的（着色器要为每种格式各写一遍），
 * 但也不该一律压成 8bit 4:2:0 —— 那等于主动扔掉画质。
 *
 * 折中方案：保留"色度采样密度"和"是否高位深"这两个真正影响画质的
 * 维度，其余交给 ffmpeg 转换。4:4:4 源仍以 4:4:4 送进来，10bit 及
 * 以上一律走 10bit 整数纹理路径。
 */
function normalizePixFmt(pixfmt, bitDepth) {
  if (PixelFormats[pixfmt]) return pixfmt;

  const f = String(pixfmt || '');
  const depth = Number(bitDepth) || (f.match(/(\d{1,2})(le|be)$/) ? Number(RegExp.$1) : 8);
  const high = depth > 8;

  // 色度密度：明确写了 444/422 就保留，其余（420/nv12/p010/gray…）按 420 处理
  let chroma = '420';
  if (/444/.test(f) || /^(gbrp|rgb|bgr|argb|rgba|abgr|bgra)/.test(f)) chroma = '444';
  else if (/422|uyvy|yuyv|yvyu/.test(f)) chroma = '422';

  return `yuv${chroma}p${high ? '10le' : ''}`;
}

/**
 * 计算一帧裸数据的总字节数。ffmpeg rawvideo 输出是紧密打包的，
 * 行宽严格等于 width（不含对齐 padding），所以可以精确按帧切分。
 */
function frameSize(pixfmt, width, height) {
  const fmt = PixelFormats[pixfmt];
  if (!fmt) throw new Error(`unsupported pixel format: ${pixfmt}`);
  let total = 0;
  for (const p of fmt.planes) {
    total += Math.ceil(width / p.wDiv) * Math.ceil(height / p.hDiv) * fmt.bytesPerSample;
  }
  return total;
}

/**
 * 计算各平面在帧缓冲内的偏移与尺寸，渲染进程据此做 subarray 切片。
 */
function planeLayout(pixfmt, width, height) {
  const fmt = PixelFormats[pixfmt];
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

module.exports = {
  HEADER_SIZE,
  PacketType,
  Flags,
  Voice,
  writeHeader,
  readHeader,
  PixelFormats,
  normalizePixFmt,
  frameSize,
  planeLayout,
};
