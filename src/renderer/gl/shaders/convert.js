import { GLSL_COLOR } from './common.js';

/**
 * Pass A：YUV → 线性/显示 RGB。
 *
 * 这一 pass 在视频原始分辨率上运行（1:1），负责所有与"源"有关的事：
 *   色度上采样 → YUV 解矩阵 → 传输函数解码 → 色域转换 →
 *   HDR 色调映射 → 去带
 *
 * 缩放放到 Pass B 做，因为缩放必须在色彩正确的线性/伽马域进行。
 * 在 YUV 域直接缩放是经典错误 —— 色度平面分辨率只有一半，
 * 插值出来的颜色会在边缘产生彩边。
 *
 * @param {object} opts
 * @param {boolean} opts.highDepth   10bit 源走整数纹理路径
 * @param {boolean} opts.deband
 */
export function buildConvertShader({ highDepth, deband }) {
  const samplerType = highDepth ? 'highp usampler2D' : 'sampler2D';

  return `#version 300 es
precision highp float;
precision highp int;

${highDepth ? '#define HIGH_DEPTH 1' : ''}
${deband ? '#define DEBAND 1' : ''}

in vec2 v_tex;
out vec4 fragColor;

uniform ${samplerType} u_plane_y;
uniform ${samplerType} u_plane_u;
uniform ${samplerType} u_plane_v;

uniform mat3  u_yuv2rgb;       // YUV → RGB 解矩阵（含 range 缩放）
uniform vec3  u_yuv_offset;    // 解矩阵前要减掉的偏移
uniform vec2  u_chroma_size;   // 色度平面尺寸，手动插值用
uniform vec2  u_luma_size;

uniform int   u_transfer;      // 0=sdr(gamma) 1=pq 2=hlg 3=linear
uniform int   u_gamut;         // 0=已是 bt709  1=bt2020→709  2=bt601→709
uniform int   u_tonemap;       // 0=clip 1=reinhard 2=hable 3=mobius 4=bt2390
uniform float u_src_peak;      // 源峰值 / 目标峰值
uniform float u_target_nits;
uniform float u_deband_strength;
uniform float u_frame_seed;    // 每帧变化，避免抖动图案静止可见

// 显示色彩管理：BT.709 线性 → 显示器实际色域（线性）。
// 单位阵时此步恒等（目标为 sRGB / 未探测到显示器时），向后兼容零变化。
uniform mat3  u_display_matrix;

${GLSL_COLOR}

// ---------------------------------------------------------------
// 采样
// ---------------------------------------------------------------

#ifdef HIGH_DEPTH
// 10bit：整数纹理不支持硬件线性过滤，色度平面手动做双线性。
// 亮度平面是 1:1 采样，nearest 即可，不引入任何插值损失
float fetchY(vec2 uv) {
  ivec2 p = ivec2(uv * u_luma_size);
  p = clamp(p, ivec2(0), ivec2(u_luma_size) - 1);
  return float(texelFetch(u_plane_y, p, 0).r) / 1023.0;
}

float fetchChroma(highp usampler2D tex, vec2 uv) {
  vec2 texel = uv * u_chroma_size - 0.5;
  vec2 base = floor(texel);
  vec2 f = texel - base;
  ivec2 p = ivec2(base);
  ivec2 mx = ivec2(u_chroma_size) - 1;

  float c00 = float(texelFetch(tex, clamp(p + ivec2(0, 0), ivec2(0), mx), 0).r);
  float c10 = float(texelFetch(tex, clamp(p + ivec2(1, 0), ivec2(0), mx), 0).r);
  float c01 = float(texelFetch(tex, clamp(p + ivec2(0, 1), ivec2(0), mx), 0).r);
  float c11 = float(texelFetch(tex, clamp(p + ivec2(1, 1), ivec2(0), mx), 0).r);

  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y) / 1023.0;
}

vec3 sampleYUV(vec2 uv) {
  return vec3(fetchY(uv), fetchChroma(u_plane_u, uv), fetchChroma(u_plane_v, uv));
}
#else
// 8bit：R8 纹理开 LINEAR，色度上采样直接交给纹理单元，零成本
vec3 sampleYUV(vec2 uv) {
  return vec3(
    texture(u_plane_y, uv).r,
    texture(u_plane_u, uv).r,
    texture(u_plane_v, uv).r
  );
}
#endif

// ---------------------------------------------------------------
// 去带
// ---------------------------------------------------------------

#ifdef DEBAND
// 在像素周围随机方向上取 3 组对称样本，若邻域差异足够小
// （说明处于平滑渐变区而非边缘），就用邻域均值替换 —— 把量化
// 台阶抹成连续渐变。边缘区域差异大，会被阈值挡住，不会糊。
vec3 debandPixel(vec2 uv, vec3 center) {
  float noise = interleaved_gradient_noise(gl_FragCoord.xy + u_frame_seed);
  float angle = noise * 6.2831853;
  vec2 texelSize = 1.0 / u_luma_size;

  vec3 sum = center;
  float count = 1.0;
  float maxDiff = 0.0;

  for (int i = 1; i <= 3; i++) {
    float r = float(i) * 8.0 * (0.5 + noise);
    float a = angle + float(i) * 2.0943951; // 每组转 120°，覆盖更均匀
    vec2 off = vec2(cos(a), sin(a)) * r * texelSize;

    vec3 s1 = sampleYUV(clamp(uv + off, vec2(0.0), vec2(1.0)));
    vec3 s2 = sampleYUV(clamp(uv - off, vec2(0.0), vec2(1.0)));

    maxDiff = max(maxDiff, max(abs(s1.x - center.x), abs(s2.x - center.x)));
    sum += s1 + s2;
    count += 2.0;
  }

  // 阈值随强度走：只在真正平坦的区域生效
  float threshold = u_deband_strength * 0.035;
  float blend = 1.0 - smoothstep(threshold * 0.5, threshold, maxDiff);
  return mix(center, sum / count, blend);
}
#endif

// ---------------------------------------------------------------

void main() {
  vec3 yuv = sampleYUV(v_tex);

#ifdef DEBAND
  yuv = debandPixel(v_tex, yuv);
#endif

  vec3 rgb = u_yuv2rgb * (yuv - u_yuv_offset);

  // ---- 传输函数：还原成线性光 ----
  if (u_transfer == 1) {
    // PQ：绝对亮度编码，1.0 == 10000 nits
    rgb = pq_eotf(clamp(rgb, 0.0, 1.0));
    rgb *= 10000.0 / u_target_nits;   // 归一化到"1.0 == 目标峰值"
  } else if (u_transfer == 2) {
    // HLG：相对场景光，需要走 OOTF 才是显示光
    rgb = hlg_inverse_oetf(clamp(rgb, 0.0, 1.0));
    rgb = hlg_ootf(rgb, u_target_nits * u_src_peak);
    rgb *= u_src_peak;
  } else if (u_transfer == 3) {
    // 已经是线性，什么都不做
  } else {
    rgb = srgb_eotf(clamp(rgb, 0.0, 1.0));
  }

  // ---- 色域 ----
  if (u_gamut == 1) rgb = BT2020_TO_BT709 * rgb;
  else if (u_gamut == 2) rgb = BT601_TO_BT709 * rgb;

  rgb = max(rgb, 0.0);

  // ---- 色调映射 ----
  // 只在源峰值确实超出目标能力时才做，否则任何映射都是白白损失对比度
  if (u_src_peak > 1.02 && u_tonemap != 0) {
    // 按亮度整体缩放而不是逐通道映射：逐通道会让高光偏色
    // （比如纯红高光被压得比绿蓝多，最终泛黄）
    float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    float mapped;

    if (u_tonemap == 1)      mapped = tm_reinhard(luma, u_src_peak);
    else if (u_tonemap == 2) mapped = tm_hable(luma, u_src_peak);
    else if (u_tonemap == 3) mapped = tm_mobius(luma, u_src_peak);
    else                     mapped = tm_bt2390(luma, u_src_peak, u_target_nits);

    float gain = luma > 1e-6 ? mapped / luma : 1.0;
    rgb *= gain;

    // 高光处适度去饱和，模拟胶片与人眼在强光下的表现，
    // 否则压缩后的高光会显得"塑料感"
    float overBright = clamp((mapped - 0.8) / 0.2, 0.0, 1.0);
    float outLuma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(rgb, vec3(outLuma), overBright * 0.25);
  }

  // ---- 显示色彩管理：BT.709 线性 → 显示器实际色域（仍在线性光域）----
  // 单位为阵时恒等；广色域屏上这一步把内容收进显示器真实色域，
  // 修正"被当成 sRGB 投进更宽色域"导致的过饱和。必须在 sRGB OETF 之前。
  rgb = u_display_matrix * rgb;

  fragColor = vec4(clamp(rgb, 0.0, 4.0), 1.0);
}
`;
}
