/**
 * WebGL2 视频渲染器。
 *
 * 两段式管线：
 *   Pass A  YUV 平面 → RGB（原始分辨率，含色彩解码/HDR/去带）
 *   Pass B  RGB → 屏幕（含高质量缩放、几何变换、画面均衡、抖动）
 *
 * 拆两段的理由是缩放必须发生在色彩正确的 RGB 域。直接在 YUV 域
 * 缩放会因为色度平面只有一半分辨率而在物体边缘产生彩色镶边，
 * 这是能一眼看出来的画质缺陷。
 */

import { VERTEX_SHADER } from './shaders/common.js';
import { buildConvertShader } from './shaders/convert.js';
import { buildOutputShader, buildKernelLUT, SCALERS } from './shaders/output.js';
import { resolveGamutMatrix } from './display-profile.js';
import { planeLayout, PixelFormats } from '../core/wire.js';

const IDENTITY_MAT3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/* ---------------- mat3 工具（列主序，与 GLSL 一致） ---------------- */

function mat3Mul(a, b) {
  const o = new Float32Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
    }
  }
  return o;
}
const mat3T = (x, y) => new Float32Array([1, 0, 0, 0, 1, 0, x, y, 1]);
const mat3S = (x, y) => new Float32Array([x, 0, 0, 0, y, 0, 0, 0, 1]);
function mat3R(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]);
}

/* ---------------- YUV 解矩阵 ---------------- */

/**
 * 由 Kr/Kb 系数推导 YUV→RGB 矩阵，并把 limited/full range 的
 * 缩放直接吸收进矩阵里，省掉着色器里的一次乘加。
 */
function buildYuvMatrix(colorSpace, colorRange, bitDepth) {
  const K = {
    bt601:  { kr: 0.299,  kb: 0.114 },
    bt709:  { kr: 0.2126, kb: 0.0722 },
    bt2020: { kr: 0.2627, kb: 0.0593 },
  }[colorSpace] || { kr: 0.2126, kb: 0.0722 };

  const { kr, kb } = K;
  const kg = 1 - kr - kb;

  // 基础矩阵（作用于 Y∈[0,1], U/V∈[-0.5,0.5]）
  const m = [
    1, 0,                        2 * (1 - kr),
    1, -2 * kb * (1 - kb) / kg,  -2 * kr * (1 - kr) / kg,
    1, 2 * (1 - kb),             0,
  ];

  // Range 缩放。limited range 的有效码值区间随位深变化：
  // 8bit  Y:16-235  UV:16-240
  // 10bit Y:64-940  UV:64-960
  let yScale = 1, cScale = 1, yOffset = 0;
  if (colorRange === 'limited') {
    const max = (1 << bitDepth) - 1;
    const yLow = 16 << (bitDepth - 8);
    const yHigh = 235 << (bitDepth - 8);
    const cLow = 16 << (bitDepth - 8);
    const cHigh = 240 << (bitDepth - 8);
    yScale = max / (yHigh - yLow);
    cScale = max / (cHigh - cLow);
    yOffset = yLow / max;
  }

  const cCenter = 0.5;

  // 列主序打包，同时把 range 缩放并入
  const out = new Float32Array([
    m[0] * yScale, m[3] * yScale, m[6] * yScale,   // 第 0 列：Y 的系数
    m[1] * cScale, m[4] * cScale, m[7] * cScale,   // 第 1 列：U
    m[2] * cScale, m[5] * cScale, m[8] * cScale,   // 第 2 列：V
  ]);

  return { matrix: out, offset: new Float32Array([yOffset, cCenter, cCenter]) };
}

const TRANSFER_ID = { sdr: 0, pq: 1, hlg: 2, linear: 3 };
const TONEMAP_ID = { clip: 0, reinhard: 1, hable: 2, mobius: 3, bt2390: 4 };

/* ================================================================== */

export class VideoRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;

    this.programConvert = null;
    this.programOutput = null;
    this.vao = null;

    this.texY = null; this.texU = null; this.texV = null;
    this.texRGB = null;
    this.fbo = null;
    this.texKernel = null;

    this.srcWidth = 0; this.srcHeight = 0;
    this.srcSar = 1;   // 像素宽高比（SAR）；当前引擎均在帧内烘焙 DAR，默认 1
    this.pixfmt = 'yuv420p';
    this.hasFloatFBO = false;

    // 需要重编译着色器的状态
    this.shaderKey = '';

    this.options = {
      scaler: 'ewa_lanczos',
      deband: false,
      debandStrength: 0.35,
      tonemap: 'bt2390',
      targetPeak: 203,
      dither: true,
      brightness: 0, contrast: 0, saturation: 0, gamma: 0, hue: 0,
      rotation: 0,
      zoom: 1, panX: 0, panY: 0,
      displayGamut: 'auto',   // auto | srgb | display-p3 | adobe-rgb | bt2020 | custom
    };

    // 显示色彩管理矩阵覆盖（来自 EDID 实测或 ICC 文件）。null = 走 displayGamut 解析。
    this._displayMatrix = null;

    this.videoInfo = null;
    this.frameSeed = 0;
    this.hasFrame = false;

    // 性能计数
    this.gpuTimes = [];
    this.lastRenderMs = 0;
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      // 播放器每帧都全屏重绘，保留上一帧内容没有意义，
      // 关掉能让驱动省一次拷贝
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true, // 允许绕过合成器直通显示，降低一帧延迟
    });

    if (!gl) throw new Error('无法创建 WebGL2 上下文。请检查显卡驱动或硬件加速设置。');
    this.gl = gl;

    // 浮点渲染目标是 HDR 管线的前提。拿不到就退回 8bit，
    // SDR 内容不受影响，HDR 会损失高光细节但仍能播
    this.hasFloatFBO = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    this.vao = gl.createVertexArray(); // 全屏三角形由 gl_VertexID 生成，不需要顶点缓冲

    this._createKernelTexture();
    this._rebuildPrograms();

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // 平面行宽不保证 4 字节对齐
    // ffmpeg rawvideo 输出是顶行先扫描，而 WebGL 纹理默认把第 0 行放在纹理底部，
    // 直接上传会导致画面上下翻转。开启 FLIP_Y 让第 0 行对应纹理顶部。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    // 上下文丢失（驱动重置、显卡休眠）必须能恢复，否则就是永久黑屏
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this._reinitAfterRestore();
    });

    return this;
  }

  _reinitAfterRestore() {
    this.texY = this.texU = this.texV = null;
    this.texRGB = null; this.fbo = null; this.texKernel = null;
    this.shaderKey = '';
    this.srcWidth = 0;
    this.srcSar = 1;
    this._createKernelTexture();
    this._rebuildPrograms();
    if (this.videoInfo) this.configure(this.videoInfo);
  }

  /* ---------------- 着色器 ---------------- */

  _compile(type, source) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`着色器编译失败:\n${log}`);
    }
    return sh;
  }

  _link(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSource);
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`着色器链接失败:\n${log}`);
    }
    // 预取所有 uniform 位置，避免渲染循环里反复查询字符串
    const uniforms = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      uniforms[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { program: prog, uniforms };
  }

  _rebuildPrograms() {
    const gl = this.gl;
    if (!gl) return; // 无输出模式（拿不到 WebGL2）下所有 GPU 动作都空转
    const highDepth = PixelFormats[this.pixfmt]
      ? PixelFormats[this.pixfmt].bitDepth > 8 : false;

    const key = `${highDepth}|${this.options.deband}|${this.options.scaler}`;
    if (key === this.shaderKey && this.programConvert && this.programOutput) return;

    if (this.programConvert) gl.deleteProgram(this.programConvert.program);
    if (this.programOutput) gl.deleteProgram(this.programOutput.program);

    this.programConvert = this._link(VERTEX_SHADER, buildConvertShader({
      highDepth,
      deband: this.options.deband,
    }));
    this.programOutput = this._link(VERTEX_SHADER, buildOutputShader({
      scaler: this.options.scaler,
    }));

    this.shaderKey = key;
  }

  _createKernelTexture() {
    const gl = this.gl;
    if (!gl) return;
    if (this.texKernel) gl.deleteTexture(this.texKernel);

    const lut = buildKernelLUT(this.options.scaler, 1024);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // R32F + NEAREST：滤波核有负瓣，必须用浮点格式；
    // 用 NEAREST 是为了不依赖 OES_texture_float_linear 扩展，
    // 1024 个采样点的量化误差远低于可见阈值
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, lut.length, 1, 0, gl.RED, gl.FLOAT, lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texKernel = tex;
  }

  /* ---------------- 纹理与 FBO ---------------- */

  configure(videoInfo) {
    const gl = this.gl;
    this.videoInfo = videoInfo;
    if (!gl) return;

    const { width, height, pixfmt, sar } = videoInfo;
    const changed = width !== this.srcWidth || height !== this.srcHeight || pixfmt !== this.pixfmt;

    this.pixfmt = pixfmt;
    this.srcWidth = width;
    this.srcHeight = height;
    // SAR 仅影响显示适配（contain），不影响纹理尺寸（帧仍是原生存储尺寸），
    // 故不纳入 changed 纹理重建判定。
    this.srcSar = (typeof sar === 'number' && sar > 0) ? sar : 1;

    this._rebuildPrograms();

    if (!changed && this.texY) return;

    const fmt = PixelFormats[pixfmt] || PixelFormats.yuv420p;
    const highDepth = fmt.bitDepth > 8;
    const layout = planeLayout(pixfmt, width, height);

    for (const t of [this.texY, this.texU, this.texV]) if (t) gl.deleteTexture(t);

    const makePlane = (w, h) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (highDepth) {
        // 整数纹理：不能线性过滤，色度插值在着色器里手动做
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      } else {
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };

    this.texY = makePlane(layout[0].width, layout[0].height);
    this.texU = makePlane(layout[1].width, layout[1].height);
    this.texV = makePlane(layout[2].width, layout[2].height);
    this.planeLayout = layout;
    this.highDepth = highDepth;

    // 中间 RGB 纹理
    if (this.texRGB) gl.deleteTexture(this.texRGB);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);

    this.texRGB = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texRGB);
    const internal = this.hasFloatFBO ? gl.RGBA16F : gl.RGBA8;
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
    const errAfterTex = gl.getError();
    if (errAfterTex) {
      throw new Error(`中间 RGB 纹理分配失败 (${width}x${height} ${this.hasFloatFBO ? 'RGBA16F' : 'RGBA8'}): GL error 0x${errAfterTex.toString(16)}`);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texRGB, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`帧缓冲不完整 (0x${status.toString(16)})，可能是 ${width}x${height} 中间纹理在当前 GPU 上不被支持`);
    }

    this.hasFrame = false;
  }

  /**
   * 清空画布并丢弃当前帧。
   * 用于从有视频内容切换到音频-only / 无视频轨道时，
   * 避免上一帧画面残留。
   */
  clear() {
    this.hasFrame = false;
    const gl = this.gl;
    if (!gl || this.contextLost) return;

    // 必须先把 drawing buffer 尺寸同步为 CSS 显示尺寸；默认 300x150 的
    // buffer 被拉伸后无法覆盖整个窗口，会导致上一帧画面残留。
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    console.warn('[lumen][renderer] clear() 已执行，buffer=', cw, 'x', ch);
  }

  /** 上传一帧 YUV 数据。返回 true 表示成功，false 表示 GL 上传失败 */
  upload(frameData) {
    const gl = this.gl;
    if (!this.texY || this.contextLost) return false;

    const L = this.planeLayout;
    const texs = [this.texY, this.texU, this.texV];
    const format = this.highDepth ? gl.RED_INTEGER : gl.RED;
    const type = this.highDepth ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE;

    for (let i = 0; i < 3; i++) {
      const p = L[i];
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texs[i]);

      // 零拷贝切片。10bit 数据要按 Uint16 视图读，注意字节偏移必须对齐
      const view = this.highDepth
        ? new Uint16Array(frameData.buffer, frameData.byteOffset + p.offset, p.width * p.height)
        : new Uint8Array(frameData.buffer, frameData.byteOffset + p.offset, p.bytes);

      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.width, p.height, format, type, view);
    }

    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      console.error('[lumen][renderer] upload GL error 0x' + err.toString(16), this.pixfmt, this.srcWidth, this.srcHeight);
      return false;
    }

    this.hasFrame = true;
    return true;
  }

  /* ---------------- 渲染 ---------------- */

  /** 输出 UV → 源 UV 的变换矩阵，打包了 letterbox / 旋转 / 缩放 / 平移 */
  _buildTransform(canvasW, canvasH) {
    const o = this.options;
    const rot = ((o.rotation % 360) + 360) % 360;
    const rad = (rot * Math.PI) / 180;
    const swapped = rot === 90 || rot === 270;

    // 源显示宽 = 存储宽 × SAR（像素宽高比）。anamorphic 素材（如 1440x1080 SAR
    // 4:3）经此换算成 1920 显示宽，contain 适配后正确显示为 16:9；方形像素源
    // sar=1 时退化为原行为（当前引擎均在帧内烘焙 DAR，SAR 恒为 1）
    // （sar=1），不致二次拉伸。
    const vw = this.srcWidth * (this.srcSar || 1);
    const vh = this.srcHeight;
    // 旋转后占据的屏幕尺寸
    const dispW = swapped ? vh : vw;
    const dispH = swapped ? vw : vh;

    // 等比适配（contain），再乘用户 zoom
    const fit = Math.min(canvasW / dispW, canvasH / dispH);
    const scale = fit * o.zoom;

    // 组合顺序（从右往左作用于输入 uv）：
    //   uv∈[0,1] → 画布居中像素坐标 → 平移 → 逆旋转 → 除以显示尺寸 → 回到源 uv
    let M = mat3T(0.5, 0.5);
    M = mat3Mul(M, mat3S(1 / (vw * scale), 1 / (vh * scale)));
    M = mat3Mul(M, mat3R(-rad));
    M = mat3Mul(M, mat3T(-o.panX * canvasW, -o.panY * canvasH));
    M = mat3Mul(M, mat3S(canvasW, canvasH));
    M = mat3Mul(M, mat3T(-0.5, -0.5));

    return { matrix: M, scale, dispW: dispW * scale, dispH: dispH * scale };
  }

  render() {
    const gl = this.gl;
    if (this.contextLost || !gl) return;

    // 无视频帧时持续清屏，避免上一文件/上一帧画面残留在画布上。
    // 必须先把 drawing buffer 尺寸同步为 CSS 显示尺寸，否则默认 300x150
    // 的小 buffer 被拉伸后无法覆盖整个窗口。
    if (!this.hasFrame || !this.texY) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
      }
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    const t0 = performance.now();
    this.frameSeed = (this.frameSeed + 1) % 1024;

    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }

    gl.bindVertexArray(this.vao);

    /* ---- Pass A：YUV → RGB ---- */
    const pc = this.programConvert;
    gl.useProgram(pc.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.srcWidth, this.srcHeight);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texY);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texU);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texV);
    gl.uniform1i(pc.uniforms.u_plane_y, 0);
    gl.uniform1i(pc.uniforms.u_plane_u, 1);
    gl.uniform1i(pc.uniforms.u_plane_v, 2);

    const vi = this.videoInfo;
    const { matrix, offset } = buildYuvMatrix(
      vi.colorSpace, vi.colorRange, this.highDepth ? 10 : 8);
    gl.uniformMatrix3fv(pc.uniforms.u_yuv2rgb, false, matrix);
    gl.uniform3fv(pc.uniforms.u_yuv_offset, offset);

    const L = this.planeLayout;
    gl.uniform2f(pc.uniforms.u_luma_size, L[0].width, L[0].height);
    gl.uniform2f(pc.uniforms.u_chroma_size, L[1].width, L[1].height);

    gl.uniform1i(pc.uniforms.u_transfer, TRANSFER_ID[vi.hdrType] ?? 0);
    gl.uniform1i(pc.uniforms.u_gamut,
      vi.colorSpace === 'bt2020' ? 1 : vi.colorSpace === 'bt601' ? 2 : 0);
    gl.uniform1i(pc.uniforms.u_tonemap, TONEMAP_ID[this.options.tonemap] ?? 4);
    gl.uniform1f(pc.uniforms.u_src_peak, this._sourcePeak());
    gl.uniform1f(pc.uniforms.u_target_nits, this.options.targetPeak);
    if (pc.uniforms.u_deband_strength) {
      gl.uniform1f(pc.uniforms.u_deband_strength, this.options.debandStrength);
    }
    gl.uniform1f(pc.uniforms.u_frame_seed, this.frameSeed);

    // 显示色彩管理：规范空间(BT.709) → 显示器实际色域的线性转换矩阵
    if (pc.uniforms.u_display_matrix) {
      gl.uniformMatrix3fv(pc.uniforms.u_display_matrix, false, this._resolveDisplayMatrix());
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* ---- Pass B：缩放 + 均衡 → 屏幕 ---- */
    const po = this.programOutput;
    gl.useProgram(po.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texRGB);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texKernel);
    gl.uniform1i(po.uniforms.u_image, 0);
    gl.uniform1i(po.uniforms.u_kernel, 1);

    const T = this._buildTransform(cw, ch);
    gl.uniformMatrix3fv(po.uniforms.u_transform, false, T.matrix);
    gl.uniform2f(po.uniforms.u_src_size, this.srcWidth, this.srcHeight);
    gl.uniform2f(po.uniforms.u_dst_size, cw, ch);

    const ratio = T.dispW / this.srcWidth;
    gl.uniform1i(po.uniforms.u_downscaling, ratio < 0.999 ? 1 : 0);
    gl.uniform1f(po.uniforms.u_scale_ratio, ratio);

    const o = this.options;
    // 配置里是 -100~100 的整数刻度，这里换算成着色器用的乘法/加法因子
    gl.uniform1f(po.uniforms.u_brightness, o.brightness / 100);
    gl.uniform1f(po.uniforms.u_contrast, 1 + o.contrast / 100);
    gl.uniform1f(po.uniforms.u_saturation, 1 + o.saturation / 100);
    gl.uniform1f(po.uniforms.u_gamma, Math.pow(2, o.gamma / 100));
    gl.uniform1f(po.uniforms.u_hue, o.hue);
    gl.uniform1i(po.uniforms.u_dither, o.dither ? 1 : 0);
    gl.uniform1f(po.uniforms.u_frame_seed, this.frameSeed * 7.3);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    this.lastRenderMs = performance.now() - t0;
    this.gpuTimes.push(this.lastRenderMs);
    if (this.gpuTimes.length > 120) this.gpuTimes.shift();
  }

  /**
   * 源峰值相对于目标显示器峰值的倍数。
   * 优先用文件里的 MaxCLL / 母版亮度；没有就按 HDR 标准假设 1000 nits。
   */
  _sourcePeak() {
    const vi = this.videoInfo;
    if (!vi || vi.hdrType === 'sdr') return 1.0;

    let nits = 1000;
    if (vi.hdr) {
      if (vi.hdr.maxCLL && vi.hdr.maxCLL > 0) nits = vi.hdr.maxCLL;
      else if (vi.hdr.masteringMaxLum && vi.hdr.masteringMaxLum > 0) nits = vi.hdr.masteringMaxLum;
    }
    if (vi.hdrType === 'hlg') nits = 1000; // HLG 是相对编码，标称峰值固定
    return Math.max(nits / this.options.targetPeak, 1.0);
  }

  setOption(key, value) {
    if (!(key in this.options)) return false;
    this.options[key] = value;
    if (key === 'scaler') {
      this._createKernelTexture();
      this._rebuildPrograms();
    } else if (key === 'deband') {
      this._rebuildPrograms();
    } else if (key === 'displayGamut') {
      // 选具体命名色域(srgb/p3/...)时撤销 EDID/ICC 覆盖，让解析结果生效；
      // 'auto'/'custom' 保留覆盖（auto 下次渲染会重新探测显示器）
      if (value && value !== 'auto' && value !== 'custom') this._displayMatrix = null;
      else if (value === 'auto') this._displayMatrix = null; // 重新触发自动探测
      this.needsRedraw = true;
    }
    return true;
  }

  /**
   * 显示色彩管理矩阵覆盖：来自 EDID 实测或加载的 ICC 文件。
   * 传 null 清除覆盖，回退到 displayGamut 配置解析。
   */
  setDisplayMatrix(mat) {
    this._displayMatrix = mat || null;
    this.needsRedraw = true;
  }

  /** 解析最终作用于着色器的显示矩阵（列主序）。 */
  _resolveDisplayMatrix() {
    if (this._displayMatrix) return this._displayMatrix;
    const m = resolveGamutMatrix(this.options.displayGamut);
    this._displayMatrix = m || IDENTITY_MAT3;
    return this._displayMatrix;
  }

  /** 截图：返回 dataURL。includeOSD=false 时只取视频画面 */
  screenshot(format = 'png') {
    if (!this.gl) throw new Error('无视频输出模式下无法截图');
    // WebGL 用了 preserveDrawingBuffer:false，必须在同一帧重绘后立刻读取
    this.render();
    return this.canvas.toDataURL(format === 'jpg' ? 'image/jpeg' : 'image/png', 0.95);
  }

  get avgRenderMs() {
    if (!this.gpuTimes.length) return 0;
    let s = 0;
    for (const v of this.gpuTimes) s += v;
    return s / this.gpuTimes.length;
  }

  get rendererInfo() {
    const gl = this.gl;
    if (!gl) return {};
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      floatFBO: this.hasFloatFBO,
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  }

  get scalerLabel() {
    return (SCALERS[this.options.scaler] || {}).label || this.options.scaler;
  }
}
