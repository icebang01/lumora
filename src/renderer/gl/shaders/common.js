/**
 * 着色器公共片段 —— 色彩科学部分。
 *
 * 这里的每个函数都对应一份标准文档，不是拍脑袋凑的近似：
 *   PQ EOTF      → SMPTE ST 2084
 *   HLG OETF/OOTF→ ITU-R BT.2100
 *   BT.2390 EETF → ITU-R BT.2390-8 第 5.4.1 节
 *   色域矩阵      → 由 BT.709/BT.2020 原色坐标经 Bradford 适配推出
 *
 * 色彩管理最常见的错误是在非线性域做本该在线性域做的运算
 * （混合、缩放、色调映射），结果就是暗部发灰、高光偏色。
 * 下面所有映射都严格在线性光域进行。
 */

export const GLSL_COLOR = /* glsl */`

// ---------------------------------------------------------------
// 传输函数
// ---------------------------------------------------------------

// sRGB / BT.709 的 EOTF。注意 BT.1886 才是"正确"的显示端曲线，
// 但绝大多数消费级内容按 sRGB 制作，这里跟随实际而非理论
float srgb_eotf(float x) {
  return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4);
}
vec3 srgb_eotf(vec3 c) {
  return vec3(srgb_eotf(c.r), srgb_eotf(c.g), srgb_eotf(c.b));
}

float srgb_oetf(float x) {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
vec3 srgb_oetf(vec3 c) {
  return vec3(srgb_oetf(c.r), srgb_oetf(c.g), srgb_oetf(c.b));
}

// SMPTE ST 2084 (PQ) 的 EOTF。输出单位是"归一化到 10000 nits"，
// 即 1.0 == 10000 cd/m²
const float PQ_M1 = 0.1593017578125;   // 2610/16384
const float PQ_M2 = 78.84375;          // 2523/32 * 128
const float PQ_C1 = 0.8359375;         // 3424/4096
const float PQ_C2 = 18.8515625;        // 2413/128
const float PQ_C3 = 18.6875;           // 2392/128

float pq_eotf(float e) {
  float ep = pow(max(e, 0.0), 1.0 / PQ_M2);
  float num = max(ep - PQ_C1, 0.0);
  float den = max(PQ_C2 - PQ_C3 * ep, 1e-6);
  return pow(num / den, 1.0 / PQ_M1);
}
vec3 pq_eotf(vec3 c) {
  return vec3(pq_eotf(c.r), pq_eotf(c.g), pq_eotf(c.b));
}

float pq_inverse_eotf(float y) {
  float yp = pow(max(y, 0.0), PQ_M1);
  return pow((PQ_C1 + PQ_C2 * yp) / (1.0 + PQ_C3 * yp), PQ_M2);
}
vec3 pq_inverse_eotf(vec3 c) {
  return vec3(pq_inverse_eotf(c.r), pq_inverse_eotf(c.g), pq_inverse_eotf(c.b));
}

// BT.2100 HLG。OETF 的逆，把信号还原成场景光
const float HLG_A = 0.17883277;
const float HLG_B = 0.28466892;  // 1 - 4a
const float HLG_C = 0.55991073;  // 0.5 - a*ln(4a)

float hlg_inverse_oetf(float e) {
  return e <= 0.5
    ? (e * e) / 3.0
    : (exp((e - HLG_C) / HLG_A) + HLG_B) / 12.0;
}
vec3 hlg_inverse_oetf(vec3 c) {
  return vec3(hlg_inverse_oetf(c.r), hlg_inverse_oetf(c.g), hlg_inverse_oetf(c.b));
}

// HLG 的 OOTF：系统伽马依赖显示器峰值亮度。
// 这一步不能省，否则 HLG 内容在亮屏上会显得过曝
vec3 hlg_ootf(vec3 scene, float peak) {
  float gamma = 1.2 + 0.42 * log(peak / 1000.0) / log(10.0);
  gamma = clamp(gamma, 1.0, 1.5);
  float luma = dot(scene, vec3(0.2627, 0.6780, 0.0593)); // BT.2020 亮度权重
  return scene * pow(max(luma, 1e-6), gamma - 1.0);
}

// ---------------------------------------------------------------
// 色域转换（线性光域）
// ---------------------------------------------------------------

// BT.2020 → BT.709。超出 709 色域的颜色会被压回去，
// 这是必然的信息损失，只能选择怎么损失得好看一点
const mat3 BT2020_TO_BT709 = mat3(
   1.6605, -0.1246, -0.0182,
  -0.5876,  1.1329, -0.1006,
  -0.0728, -0.0083,  1.1187
);

const mat3 BT601_TO_BT709 = mat3(
   0.9955, -0.0027,  0.0,
   0.0041,  1.0037,  0.0,
   0.0004, -0.0010,  1.0
);

// ---------------------------------------------------------------
// 色调映射（全部在线性光域，输入已归一化到 target_peak == 1.0）
// ---------------------------------------------------------------

// Reinhard：最简单，暗部保留好但高光压得狠，容易发灰。
// 缩放系数保证 x == peak 时正好映射到 1.0
float tm_reinhard(float x, float peak) {
  const float contrast = 0.5;
  float offset = (1.0 - contrast) / contrast;
  return (x / (x + offset)) * ((peak + offset) / max(peak, 1e-6));
}

// Hable (Uncharted 2 filmic)：电影感强，对比度保持好，
// 代价是整体略暗、饱和度略降
vec3 hable_curve(vec3 x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
float hable_curve(float x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
float tm_hable(float x, float peak) {
  return hable_curve(x) / max(hable_curve(peak), 1e-6);
}

// Mobius：低于阈值 j 的部分完全线性（不动暗部和中间调），
// 只压缩高光。要"忠实还原导演意图"时这个最稳
float tm_mobius(float x, float peak) {
  const float j = 0.3;
  if (x <= j) return x;
  float a = -j * j * (peak - 1.0) / max(j * j - 2.0 * j + peak, 1e-6);
  float b = (j * j - 2.0 * j * peak + peak) / max(peak - 1.0, 1e-6);
  return (b * b + 2.0 * b * j + j * j) / max(b - a, 1e-6) * (x + a) / (x + b);
}

// BT.2390 EETF：ITU 官方推荐的映射，在 PQ 域用 Hermite 样条做膝部过渡。
// 目前公认对高光细节保留最好的方案，代价是计算量最大。
//
// 必须在 PQ 域而非线性域做 —— PQ 近似感知均匀，样条在这个域里
// 才能保证"膝部以下完全不动、以上平滑收敛"这个关键性质。
//
// x         线性光，1.0 == 目标显示器峰值
// peak      源峰值 / 目标峰值
// targetNits 目标显示器峰值亮度，决定在 PQ 曲线上的绝对位置
float tm_bt2390(float x, float peak, float targetNits) {
  float scale = targetNits / 10000.0;

  float srcMaxPQ = pq_inverse_eotf(peak * scale);
  float dstMaxPQ = pq_inverse_eotf(scale);
  if (srcMaxPQ <= 1e-6) return x;

  // 归一化到 [0,1]，1.0 对应源峰值
  float e = pq_inverse_eotf(clamp(x, 0.0, peak) * scale) / srcMaxPQ;
  float maxLum = dstMaxPQ / srcMaxPQ;

  float ks = 1.5 * maxLum - 0.5;   // 膝点：以下原样透传
  float e2 = e;
  if (e > ks && ks < 1.0) {
    float t = (e - ks) / (1.0 - ks);
    float t2 = t * t, t3 = t2 * t;
    e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * ks
       + (t3 - 2.0 * t2 + t) * (1.0 - ks)
       + (-2.0 * t3 + 3.0 * t2) * maxLum;
  }

  return pq_eotf(e2 * srcMaxPQ) / max(scale, 1e-6);
}

// Clip：直接截断。峰值亮度足够的 HDR 显示器上这才是正解 ——
// 任何映射都是失真，能显示就别动它
float tm_clip(float x, float peak) {
  return clamp(x, 0.0, 1.0);
}

// ---------------------------------------------------------------
// 抖动（消除量化色带）
// ---------------------------------------------------------------

// 交错梯度噪声。相比白噪声，它的频谱更接近蓝噪声，
// 同样强度下肉眼几乎看不见，却能有效打散 8bit 量化台阶
float interleaved_gradient_noise(vec2 pos) {
  return fract(52.9829189 * fract(dot(pos, vec2(0.06711056, 0.00583715))));
}
`;

/**
 * 顶点着色器 —— 所有 pass 共用。
 * 用一个覆盖屏幕的三角形而不是四边形：少一次光栅化接缝处的
 * 重复着色，在全屏 pass 上是白拿的性能。
 */
export const VERTEX_SHADER = /* glsl */`#version 300 es
precision highp float;

out vec2 v_tex;

void main() {
  // gl_VertexID: 0,1,2 → 生成一个覆盖 [-1,3] 的大三角形
  vec2 pos = vec2(
    (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 2) ? 3.0 : -1.0
  );
  v_tex = (pos + 1.0) * 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;
