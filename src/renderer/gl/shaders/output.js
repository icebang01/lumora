import { GLSL_COLOR } from './common.js';

/**
 * Pass B：缩放 + 画面均衡 + 抖动 → 屏幕。
 *
 * 缩放核用 1D 查找表实现。理由：ewa_lanczos 需要一阶贝塞尔函数
 * J1，在片元着色器里逐像素展开多项式近似要几十条指令，而 4K 输出
 * 有 800 万像素 × 每像素几十次抽头。把核函数预计算成 LUT 纹理，
 * 每次抽头就退化成一次廉价的纹理读取 —— 这也是 mpv 的做法。
 *
 * 缩小时核半径按缩放比拉伸（correct-downscaling），否则高频成分
 * 直接混叠成摩尔纹。这一点很多播放器都做错了。
 */

export const SCALERS = {
  bilinear:    { id: 0, radius: 1.0,    separable: true,  label: '双线性' },
  bicubic:     { id: 1, radius: 2.0,    separable: true,  label: '双三次' },
  spline36:    { id: 2, radius: 3.0,    separable: true,  label: 'Spline36' },
  ewa_lanczos: { id: 3, radius: 3.2383, separable: false, label: 'EWA Lanczos' },
};

export function buildOutputShader({ scaler }) {
  const info = SCALERS[scaler] || SCALERS.bilinear;

  return `#version 300 es
precision highp float;

#define SCALER_ID ${info.id}
#define KERNEL_RADIUS ${info.radius.toFixed(4)}
${info.separable ? '#define SEPARABLE 1' : ''}

in vec2 v_tex;
out vec4 fragColor;

uniform sampler2D u_image;
uniform sampler2D u_kernel;     // 1D 滤波核 LUT
uniform vec2  u_src_size;       // 源纹理尺寸（像素）
uniform vec2  u_dst_size;       // 目标尺寸（像素）
uniform mat3  u_transform;      // 输出 UV → 源 UV（含旋转/缩放/平移/letterbox）

uniform float u_brightness;     // -1 ~ 1
uniform float u_contrast;       // 0 ~ 2
uniform float u_saturation;     // 0 ~ 2
uniform float u_gamma;          // 0.5 ~ 2
uniform float u_hue;            // -180 ~ 180 (度)

uniform int   u_dither;
uniform float u_frame_seed;
uniform int   u_downscaling;    // 是否处于缩小状态
uniform float u_scale_ratio;    // dst/src，<1 表示缩小

${GLSL_COLOR}

// ---------------------------------------------------------------
// 滤波核查表
// ---------------------------------------------------------------

float kernelWeight(float x) {
  // LUT 归一化到 [0,1] 对应 [0, KERNEL_RADIUS]
  float t = abs(x) / KERNEL_RADIUS;
  if (t >= 1.0) return 0.0;
  return texture(u_kernel, vec2(t, 0.5)).r;
}

// ---------------------------------------------------------------
// 缩放
// ---------------------------------------------------------------

vec4 scaleBilinear(vec2 uv) {
  return texture(u_image, uv);
}

#ifdef SEPARABLE
// 可分离核：权重 = w(dx) * w(dy)，比二维核便宜得多
vec4 scaleSeparable(vec2 uv, float radiusScale) {
  vec2 pos = uv * u_src_size - 0.5;
  vec2 base = floor(pos);
  vec2 frac = pos - base;

  float r = KERNEL_RADIUS * radiusScale;
  int taps = int(ceil(r));

  vec4 sum = vec4(0.0);
  float wsum = 0.0;

  for (int dy = -taps + 1; dy <= taps; dy++) {
    float wy = kernelWeight(float(dy) - frac.y);
    if (wy == 0.0) continue;

    for (int dx = -taps + 1; dx <= taps; dx++) {
      float wx = kernelWeight(float(dx) - frac.x);
      if (wx == 0.0) continue;

      vec2 p = (base + vec2(float(dx), float(dy)) + 0.5) / u_src_size;
      float w = wx * wy;
      sum += texture(u_image, clamp(p, vec2(0.0), vec2(1.0))) * w;
      wsum += w;
    }
  }

  return wsum > 0.0 ? sum / wsum : texture(u_image, uv);
}
#else
// EWA：椭圆加权平均。权重只取决于到采样中心的欧氏距离，
// 因此在任意方向上都各向同性 —— 对角线边缘不会比水平边缘更糊，
// 这正是 EWA 比可分离核视觉上更锐利的原因
vec4 scaleEWA(vec2 uv, float radiusScale) {
  vec2 pos = uv * u_src_size - 0.5;
  vec2 base = floor(pos);
  vec2 frac = pos - base;

  float r = KERNEL_RADIUS * radiusScale;
  int taps = int(ceil(r));

  vec4 sum = vec4(0.0);
  float wsum = 0.0;

  for (int dy = -taps + 1; dy <= taps; dy++) {
    for (int dx = -taps + 1; dx <= taps; dx++) {
      vec2 d = vec2(float(dx), float(dy)) - frac;
      float dist = length(d) / radiusScale;
      if (dist >= KERNEL_RADIUS) continue;

      float w = kernelWeight(dist);
      if (w == 0.0) continue;

      vec2 p = (base + vec2(float(dx), float(dy)) + 0.5) / u_src_size;
      sum += texture(u_image, clamp(p, vec2(0.0), vec2(1.0))) * w;
      wsum += w;
    }
  }

  return wsum > 0.0 ? sum / wsum : texture(u_image, uv);
}
#endif

vec4 doScale(vec2 uv) {
#if SCALER_ID == 0
  return scaleBilinear(uv);
#else
  // 缩小时把核拉宽做低通，抑制混叠；放大时保持原半径
  float radiusScale = u_downscaling == 1 ? max(1.0 / max(u_scale_ratio, 0.05), 1.0) : 1.0;
  radiusScale = min(radiusScale, 3.0); // 上限保护，避免极端缩小时抽头爆炸

  #ifdef SEPARABLE
    return scaleSeparable(uv, radiusScale);
  #else
    return scaleEWA(uv, radiusScale);
  #endif
#endif
}

// ---------------------------------------------------------------
// 画面均衡
// ---------------------------------------------------------------

vec3 applyHue(vec3 c, float degrees) {
  if (abs(degrees) < 0.01) return c;
  float a = radians(degrees);
  float s = sin(a), cs = cos(a);
  // 绕 YIQ 亮度轴旋转色度平面 —— 比在 HSV 里转更保亮度
  mat3 m = mat3(
    0.299 + 0.701 * cs + 0.168 * s,  0.587 - 0.587 * cs + 0.330 * s,  0.114 - 0.114 * cs - 0.497 * s,
    0.299 - 0.299 * cs - 0.328 * s,  0.587 + 0.413 * cs + 0.035 * s,  0.114 - 0.114 * cs + 0.292 * s,
    0.299 - 0.300 * cs + 1.250 * s,  0.587 - 0.588 * cs - 1.050 * s,  0.114 + 0.886 * cs - 0.203 * s
  );
  return m * c;
}

vec3 applyEQ(vec3 c) {
  // 顺序有讲究：对比度围绕中灰旋转，必须在亮度偏移之前，
  // 否则调亮之后再拉对比度会把高光推爆
  c = (c - 0.5) * u_contrast + 0.5;
  c += u_brightness;

  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, u_saturation);

  c = applyHue(c, u_hue);

  c = max(c, 0.0);
  if (abs(u_gamma - 1.0) > 0.001) c = pow(c, vec3(1.0 / u_gamma));

  return c;
}

// ---------------------------------------------------------------

void main() {
  // 输出 UV → 源 UV。变换矩阵里已经打包了 letterbox、旋转、缩放平移
  vec3 t = u_transform * vec3(v_tex, 1.0);
  vec2 uv = t.xy;

  // 画面外区域给黑，形成 letterbox / pillarbox
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 color = doScale(uv).rgb;

  // Pass A 输出的是线性光，编码回显示域再做均衡 ——
  // 亮度/对比度这类操作是为伽马域设计的，在线性域做会显得很怪
  color = srgb_oetf(clamp(color, 0.0, 1.0));

  color = applyEQ(color);

  if (u_dither == 1) {
    // ±半个 8bit 台阶的三角分布噪声，把量化误差打散成噪点
    float n1 = interleaved_gradient_noise(gl_FragCoord.xy + u_frame_seed);
    float n2 = interleaved_gradient_noise(gl_FragCoord.xy + u_frame_seed + 17.0);
    color += ((n1 + n2) - 1.0) / 255.0;
  }

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
}

/**
 * 生成滤波核 LUT 数据。
 *
 * 在 JS 里算这些函数一点问题都没有 —— 每次切换缩放算法才算一次，
 * 512 个点的开销可以忽略。真正贵的是在着色器里逐像素算。
 */
export function buildKernelLUT(scaler, size = 512) {
  const info = SCALERS[scaler] || SCALERS.bilinear;
  const lut = new Float32Array(size);
  const R = info.radius;

  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * R;
    lut[i] = kernelFunction(scaler, x, R);
  }
  return lut;
}

/** jinc 的第一个零点，EWA 加窗要用 */
const JINC_FIRST_ZERO = 1.2196698912665045;

function kernelFunction(name, x, R) {
  const ax = Math.abs(x);
  if (ax >= R) return 0;

  switch (name) {
    case 'bilinear':
      return Math.max(0, 1 - ax);

    case 'bicubic': {
      // Mitchell-Netravali B=C=1/3：模糊与振铃之间公认的最佳折中
      const B = 1 / 3, C = 1 / 3;
      const x2 = ax * ax, x3 = x2 * ax;
      if (ax < 1) {
        return ((12 - 9 * B - 6 * C) * x3 +
                (-18 + 12 * B + 6 * C) * x2 +
                (6 - 2 * B)) / 6;
      }
      if (ax < 2) {
        return ((-B - 6 * C) * x3 +
                (6 * B + 30 * C) * x2 +
                (-12 * B - 48 * C) * ax +
                (8 * B + 24 * C)) / 6;
      }
      return 0;
    }

    case 'spline36': {
      // 分段三次样条，6 抽头。比 bicubic 锐利，振铃控制得也不错
      if (ax < 1) {
        return ((13 / 11 * ax - 453 / 209) * ax - 3 / 209) * ax + 1;
      }
      if (ax < 2) {
        const t = ax - 1;
        return ((-6 / 11 * t + 270 / 209) * t - 156 / 209) * t;
      }
      if (ax < 3) {
        const t = ax - 2;
        return ((1 / 11 * t - 45 / 209) * t + 26 / 209) * t;
      }
      return 0;
    }

    case 'ewa_lanczos': {
      // Jinc 加窗的 Jinc。
      // jinc(x) = 2·J1(πx)/(πx)，第一个零点在 x = 1.21967。
      // 半径 3.2383 正好是第三个零点，核函数在边界自然收敛到 0，
      // 不需要额外截断，也就不会产生截断造成的振铃。
      const jinc = (v) => {
        if (Math.abs(v) < 1e-8) return 1;
        const pv = Math.PI * v;
        return (2 * besselJ1(pv)) / pv;
      };
      const base = jinc(ax);              // 基函数
      const window = jinc((ax / R) * JINC_FIRST_ZERO); // 窗口，x=R 处归零
      return base * window;
    }

    default:
      return Math.max(0, 1 - ax);
  }
}

/**
 * 一阶第一类贝塞尔函数 J1。
 * 用 Abramowitz & Stegun 9.4.4 / 9.4.6 的多项式近似，
 * 绝对误差 < 1e-7，对滤波核来说远远够用。
 */
function besselJ1(x) {
  const ax = Math.abs(x);
  let result;

  if (ax < 8.0) {
    const y = x * x;
    const p1 = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 +
      y * (-2972611.439 + y * (15704.48260 + y * (-30.16036606))))));
    const p2 = 144725228442.0 + y * (2300535178.0 + y * (18583304.74 +
      y * (99447.43394 + y * (376.9991397 + y * 1.0))));
    result = p1 / p2;
  } else {
    const z = 8.0 / ax;
    const y = z * z;
    const xx = ax - 2.356194491; // ax - 3π/4
    const p1 = 1.0 + y * (0.183105e-2 + y * (-0.3516396496e-4 +
      y * (0.2457520174e-5 + y * (-0.240337019e-6))));
    const p2 = 0.04687499995 + y * (-0.2002690873e-3 +
      y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
    result = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p1 - z * Math.sin(xx) * p2);
    if (x < 0) result = -result;
  }

  return result;
}
