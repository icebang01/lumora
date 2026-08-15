'use strict';
/**
 * 媒体探测。用 ffprobe 一次性拿全所有播放决策需要的信息：
 * 轨道拓扑、色彩学元数据、HDR 参数、旋转矩阵、章节。
 *
 * 这一步的准确性直接决定渲染管线选什么 YUV→RGB 矩阵、
 * 要不要做色调映射、画面要不要转向 —— 探错了画面颜色就是错的。
 */

const { execFile } = require('child_process');
const { resolveBinary } = require('./binaries');

/** "30000/1001" → 29.97 */
function parseRational(str, fallback = 0) {
  if (!str || typeof str !== 'string') return fallback;
  const [n, d] = str.split('/').map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return fallback;
  return n / d;
}

/**
 * 从 side_data 中提取旋转角。
 * ffprobe 新版本直接给 rotation 字段，老版本要从 displaymatrix 文本里抠。
 */
function extractRotation(stream) {
  const list = stream.side_data_list || [];
  for (const sd of list) {
    if (sd.rotation !== undefined) {
      // ffmpeg 给的是逆时针负角，转成顺时针正角便于渲染端理解
      const r = ((-Number(sd.rotation) % 360) + 360) % 360;
      return r;
    }
    if (typeof sd.displaymatrix === 'string') {
      const m = sd.displaymatrix.match(/rotation of ([-\d.]+) degrees/);
      if (m) return ((-parseFloat(m[1]) % 360) + 360) % 360;
    }
  }
  const tagRot = stream.tags && (stream.tags.rotate || stream.tags.ROTATE);
  if (tagRot) return ((Number(tagRot) % 360) + 360) % 360;
  return 0;
}

/**
 * 提取 HDR 静态元数据（HDR10 的 MaxCLL / MaxFALL / 母版显示器亮度）。
 * 色调映射需要知道源的峰值亮度，否则只能按 1000 nits 猜。
 */
function extractHdrMetadata(stream) {
  const meta = { maxCLL: null, maxFALL: null, masteringMaxLum: null, masteringMinLum: null };
  for (const sd of stream.side_data_list || []) {
    const t = (sd.side_data_type || '').toLowerCase();
    if (t.includes('content light level')) {
      meta.maxCLL = Number(sd.max_content) || null;
      meta.maxFALL = Number(sd.max_average) || null;
    }
    if (t.includes('mastering display')) {
      // ffprobe 输出形如 "10000000/10000"，需要化简
      meta.masteringMaxLum = parseRational(String(sd.max_luminance), null);
      meta.masteringMinLum = parseRational(String(sd.min_luminance), null);
    }
  }
  return meta;
}

function classifyTransfer(transfer) {
  const t = (transfer || '').toLowerCase();
  if (t === 'smpte2084' || t === 'smpte st 2084') return 'pq';
  if (t === 'arib-std-b67') return 'hlg';
  return 'sdr';
}

/**
 * 检测 Dolby Vision：ffprobe 会把 DV 流报成 dvhe/dvav 编码名，
 * 或在 side_data 里给出 dolby_vision_metadata（含 dv_profile）。
 * 返回 dv_profile 数字（如 5/8/10），非 DV 返回 null。
 */
function detectDolbyVision(stream) {
  const cn = (stream.codec_name || '').toLowerCase();
  let profile = null;
  if (cn.startsWith('dvhe') || cn.startsWith('dvav')) {
    const m = cn.match(/\.(\d+)/);
    profile = m ? Number(m[1]) : 0;
  }
  for (const sd of stream.side_data_list || []) {
    const t = (sd.side_data_type || '').toLowerCase();
    if (t.includes('dolby') && t.includes('vision')) {
      profile = sd.dv_profile != null ? Number(sd.dv_profile) : (profile == null ? 0 : profile);
    }
  }
  return profile;
}

/**
 * 检测 HDR10+ 动态元数据（side_data type == 137），或流标签里显式写了 HDR10+。
 */
function detectHdr10Plus(stream) {
  for (const sd of stream.side_data_list || []) {
    const t = (sd.side_data_type || '').toLowerCase();
    if (t.includes('dynamic metadata') || t.includes('hdr10')) {
      if (sd.type === 137) return true;
    }
  }
  const tags = stream.tags || {};
  const hay = [tags['HDR10+'], tags.hdr10_plus, tags.HDR10PLUS]
    .filter(Boolean).join(' ').toLowerCase();
  return /hdr10\+/.test(hay);
}

/**
 * 归一化 HDR 流派：DV 优先，其次 HDR10+ / HDR10(PQ) / HLG / SDR。
 */
function classifyHdrVariant(stream) {
  if (detectDolbyVision(stream) != null) return 'dolby-vision';
  if (detectHdr10Plus(stream)) return 'hdr10+';
  const tr = classifyTransfer(stream.color_transfer);
  if (tr === 'pq') return 'hdr10';
  if (tr === 'hlg') return 'hlg';
  return 'sdr';
}

/**
 * 音频杜比家族 + Atmos 检测。
 * 编码名 ac3/eac3/truehd 对应杜比数字系列；Atmos 通常体现在
 * profile / handler / title 标签里出现 "Atmos" 字样。
 */
function detectDolbyAudio(stream) {
  const cn = (stream.codec_name || '').toLowerCase();
  let label = null;
  if (cn === 'ac3') label = 'Dolby Digital';
  else if (cn === 'eac3') label = 'Dolby Digital Plus';
  else if (cn === 'truehd') label = 'Dolby TrueHD';
  const hay = [
    stream.profile,
    stream.codec_long_name,
    stream.tags && (stream.tags.title || stream.tags.handler || stream.tags.TITLE || ''),
  ].filter(Boolean).join(' ').toLowerCase();
  const atmos = /\batmos\b/.test(hay);
  if (atmos && label) label = 'Dolby Atmos';
  return { dolbyLabel: label, atmos };
}

/**
 * 归一化色彩空间名称。ffprobe 在不同版本会输出 bt709 / BT.709 / unknown，
 * 统一成渲染端认识的 key；缺失时按分辨率启发式推断（这是业界通行做法：
 * SD 内容默认 BT.601，HD 默认 BT.709，UHD 默认 BT.2020）。
 */
function normalizeColorSpace(stream) {
  const raw = (stream.color_space || '').toLowerCase();
  const map = {
    bt709: 'bt709',
    bt470bg: 'bt601',
    smpte170m: 'bt601',
    smpte240m: 'bt601',
    bt2020nc: 'bt2020',
    'bt2020_ncl': 'bt2020',
    bt2020c: 'bt2020',
    fcc: 'bt601',
  };
  if (map[raw]) return map[raw];
  // 无标记时不再按分辨率推断 bt2020:实测无标记 4K 杜比测试片为 bt709 语义,
  // 按分辨率推断 bt2020 → 渲染端做 bt2020→bt709 色域转换 → 画面偏绿发灰
  // (mpv/ffmpeg 对无标记内容默认 bt709 → 颜色正常)。仅当传输函数明确为
  // HDR(PQ/HLG)才推断 bt2020(真 HDR 内容一定带 transfer 标记)。
  const trc = (stream.color_transfer || '').toLowerCase();
  if (/pq|smpte2084|hlg|arib-std-b67/.test(trc)) return 'bt2020';
  const h = Number(stream.height) || 0;
  if (h >= 600) return 'bt709';
  return 'bt601';
}

function pickPixelFormat(srcPixFmt) {
  // 我们的渲染管线只吃这两种平面格式，其余一律让 ffmpeg 转换过来。
  // 10bit 源保持 10bit 传输，避免在解码侧就把 HDR 的动态范围截断。
  const f = (srcPixFmt || '').toLowerCase();
  const isHighDepth = /p(10|12|16)(le|be)?$/.test(f) || f.includes('10le') || f.includes('12le');
  return isHighDepth ? 'yuv420p10le' : 'yuv420p';
}

function runProbe(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`ffprobe failed: ${err.message}\n${stderr || ''}`));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`ffprobe output is not valid JSON: ${e.message}`));
        }
      });
  });
}

/**
 * @param {string} filePath 媒体文件路径或 URL
 * @param {{ffprobePath?: string, timeoutMs?: number}} opts
 */
async function probeMedia(filePath, opts = {}) {
  const bin = resolveBinary('ffprobe', opts.ffprobePath);
  if (!bin) {
    throw new Error('找不到 ffprobe。请安装 FFmpeg 并加入 PATH，或在 player.conf 中设置 ffmpeg-dir。');
  }

  const raw = await runProbe(bin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-i', filePath,
  ], opts.timeoutMs || 30000);

  const streams = raw.streams || [];
  const format = raw.format || {};

  const video = [];
  const audio = [];
  const subtitle = [];

  for (const s of streams) {
    const tags = s.tags || {};
    const base = {
      index: s.index,
      codec: s.codec_name || 'unknown',
      codecLong: s.codec_long_name || '',
      lang: tags.language || tags.LANGUAGE || null,
      title: tags.title || tags.TITLE || null,
      isDefault: !!(s.disposition && s.disposition.default),
      isForced: !!(s.disposition && s.disposition.forced),
    };

    if (s.codec_type === 'video') {
      // 封面图/缩略图会被识别成视频流，必须排除，否则会误当主画面
      if (s.disposition && s.disposition.attached_pic) continue;

      const fps = parseRational(s.avg_frame_rate, 0) || parseRational(s.r_frame_rate, 0) || 25;
      const sar = parseRational(s.sample_aspect_ratio, 1) || 1;
      video.push({
        ...base,
        width: Number(s.width) || 0,
        height: Number(s.height) || 0,
        fps,
        srcPixFmt: s.pix_fmt || 'yuv420p',
        pixfmt: pickPixelFormat(s.pix_fmt),
        bitDepth: /10/.test(s.pix_fmt || '') ? 10 : /12/.test(s.pix_fmt || '') ? 12 : 8,
        colorSpace: normalizeColorSpace(s),
        colorRange: (s.color_range || '').toLowerCase() === 'pc' ? 'full' : 'limited',
        colorPrimaries: (s.color_primaries || '').toLowerCase() || 'unknown',
        colorTransfer: (s.color_transfer || '').toLowerCase() || 'unknown',
        hdrType: classifyTransfer(s.color_transfer),
        hdrVariant: classifyHdrVariant(s),
        dvProfile: detectDolbyVision(s),
        hdr10plus: detectHdr10Plus(s),
        hdr: extractHdrMetadata(s),
        rotation: extractRotation(s),
        sar,
        // 显示宽高比：非方形像素（DVD、部分录制素材）必须靠 SAR 拉伸才不变形
        dar: (Number(s.width) || 1) * sar / (Number(s.height) || 1),
        bitrate: Number(s.bit_rate) || null,
        nbFrames: Number(s.nb_frames) || null,
      });
    } else if (s.codec_type === 'audio') {
      const dolby = detectDolbyAudio(s);
      audio.push({
        ...base,
        sampleRate: Number(s.sample_rate) || 48000,
        channels: Number(s.channels) || 2,
        channelLayout: s.channel_layout || null,
        bitrate: Number(s.bit_rate) || null,
        dolbyLabel: dolby.dolbyLabel,
        atmos: dolby.atmos,
      });
    } else if (s.codec_type === 'subtitle') {
      // 图形字幕(pgs/dvdsub)与文本字幕(srt/ass)渲染路径完全不同，先标注出来
      const graphic = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];
      subtitle.push({ ...base, graphic: graphic.includes(base.codec) });
    }
  }

  const chapters = (raw.chapters || []).map((c, i) => ({
    index: i,
    start: parseFloat(c.start_time) || 0,
    end: parseFloat(c.end_time) || 0,
    title: (c.tags && (c.tags.title || c.tags.TITLE)) || `章节 ${i + 1}`,
  }));

  // 时长优先取容器时长；流式/不完整文件容器可能没有，退回视频流时长
  let duration = parseFloat(format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    for (const s of streams) {
      const d = parseFloat(s.duration);
      if (Number.isFinite(d) && d > duration) duration = d;
    }
  }
  if (!Number.isFinite(duration)) duration = 0;

  // 容器级标签（音乐元数据）：artist / album / album_artist / date / genre 等。
  // ffprobe 通常归一化为小写键，但稳妥起见大小写都尝试。
  const ft = format.tags || {};
  const tagPick = (...keys) => {
    for (const k of keys) {
      const v = ft[k] || ft[String(k).toUpperCase()];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  };

  return {
    path: filePath,
    container: format.format_name || 'unknown',
    containerLong: format.format_long_name || '',
    duration,
    size: Number(format.size) || null,
    bitrate: Number(format.bit_rate) || null,
    title: (format.tags && (format.tags.title || format.tags.TITLE)) || null,
    artist: tagPick('artist'),
    album: tagPick('album'),
    albumArtist: tagPick('album_artist'),
    date: tagPick('date'),
    genre: tagPick('genre'),
    composer: tagPick('composer'),
    lyricist: tagPick('lyricist', 'writer'),
    arranger: tagPick('arranger'),
    video,
    audio,
    subtitle,
    chapters,
    hasVideo: video.length > 0,
    hasAudio: audio.length > 0,
    // 只有音频没有视频 → 走可视化/纯音频模式
    audioOnly: video.length === 0 && audio.length > 0,
  };
}

module.exports = { probeMedia, parseRational };
