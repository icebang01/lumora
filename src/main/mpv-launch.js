/**
 * MPV 后端启动（自包含模块）。
 * 从 index.js 拆出（2026-08）：resolveMpvPath / createMpvBackend / startMpv。
 * 用法：setCtx({ getConfig, getMpvBackend, setMpvBackend, sendToRenderer })（bootstrap 时注入；
 * mpvBackend 是 index.js 顶层变量，读写走 getter/setter 保持单一事实源）。
 * 注意：createMpvBackend 必须在窗口创建前调用（渲染端 boot() 可能先于 startMpv 触发 loadFile）。
 */
const path = require('path');
const fs = require('fs');
const { resolveBinary } = require('./ffmpeg/binaries');
const { MpvBackend } = require('./mpv-backend');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getBackend(source) { return CTX.getBackend ? CTX.getBackend(source) : null; }
function setBackend(source, v) { if (CTX.setBackend) CTX.setBackend(source, v); }
function sendToRenderer(channel, payload) { if (CTX.sendToRenderer) CTX.sendToRenderer(channel, payload); }

/* MPV 后端                                                             */
/* ------------------------------------------------------------------ */

/**
 * 查找 mpv 可执行文件。优先级：
 *   1. config 里的 mpv-dir
 *   2. bin 目录（和 ffmpeg 放一起）
 *   3. 系统 PATH
 */
function resolveMpvPath() {
  const dir = getConfig().get('mpv-dir') || getConfig().get('ffmpeg-dir');
  if (dir) {
    const p = path.join(dir, 'mpv.exe');
    if (fs.existsSync(p)) return p;
  }
  return resolveBinary('mpv', null);
}

/**
 * 创建 mpv 后端实例并接线事件转发（仅构造，不启动进程）。
 *
 * 必须在窗口创建前（bootstrap 里）就调用：渲染端 boot() 可能比
 * startMpv（ready-to-show 后延迟 300ms 才 spawn mpv）更快触发
 * loadFile()。若此时后端还是 null，loadFile 的 mpv 分支会被整体跳过，
 * player:loaded 仍会照发（信息来自 ffprobe）→ UI 显示"已载入"但 mpv 从未
 * 收到 loadfile，空转 idle，time-pos 恒为 0（冒烟测试的"播放推进"必挂）。
 * 提前创建后，loadFile 会走 `await backend.whenReady()` 正确等待就绪。
 *
 * 事件/属性转发保留 `source` 标签（音乐模式已移除，恒为 'video'），
 * 渲染端 MpvPlayer 按 source 过滤，保持兼容。
 */
function createMpvBackend(source, opts = {}) {
  if (getBackend()) return getBackend();

  const backend = new MpvBackend({
    mpvPath: opts.mpvPath,
    config: getConfig(),
    mode: 'video',
  });

  // 转发 mpv 属性变化到渲染端，带 source 标签
  backend.on('property', ({ name, value }) => {
    sendToRenderer('mpv:property', { source, name, value });
  });

  // 转发 mpv 事件
  backend.on('file-loaded', () => {
    sendToRenderer('mpv:event', { source, type: 'file-loaded' });
  });

  backend.on('end-file', (data) => {
    sendToRenderer('mpv:event', { source, type: 'end-file', data });
  });

  backend.on('idle', () => {
    sendToRenderer('mpv:event', { source, type: 'idle' });
  });

  backend.on('vo-reconfig', () => {
    // 仅视频引擎有 VO；音频引擎（--vo=null）不会触发此事件
    sendToRenderer('mpv:event', { source, type: 'vo-reconfig' });
  });

  backend.on('error', (err) => {
    console.error('[mpv]', err.message);
    sendToRenderer('player:error', { source, message: err.message });
  });

  backend.on('log', ({ level, prefix, text }) => {
    if (level === 'error' || level === 'warn') {
      sendToRenderer('player:log', { stream: 'mpv', text: `[${prefix}] ${text}` });
    }
  });

  setBackend(source, backend);
  return backend;
}

async function startMpv(window) {
  const mpvPath = resolveMpvPath();
  if (!mpvPath) {
    const msg = '找不到 mpv 可执行文件，请在 player.conf 中设置 mpv-dir 或将 mpv.exe 放入 bin 目录';
    console.error('[mpv]', msg);
    sendToRenderer('player:error', { message: msg });
    throw new Error(msg);
  }

  console.log('[mpv] 可执行文件:', mpvPath);
  createMpvBackend('video', { mpvPath });

  try {
    const hwnd = window.getNativeWindowHandle();
    await getBackend('video').start(hwnd);
    console.log('[mpv] 视频后端已启动');

    // 如果最终落到纯音频兜底模式（无 GPU 环境），友好降级提示而非致命错误
    if (getBackend('video').activeMode === 'audio-only') {
      sendToRenderer('player:degraded', {
        reason: '当前环境无可用 GPU 渲染表面，已自动降级为纯音频模式（有声音、无画面）。如需视频画面，请在有独立显卡的机器上运行 Lumora。',
      });
    }

    // 应用初始配置到 mpv
    // 注意：sub-auto / slang 是 mpv 启动选项，已在 mpv-backend 的 _baseArgs
    // 里通过 CLI 传入（本构建对 sub-auto 的 set_property 会报
    // "unsupported format for accessing property"，不能用 set_property 设）。
    const cfg = getConfig();
    await getBackend('video').setProperty('volume', cfg.get('volume') ?? 100);
    if (cfg.get('mute')) await getBackend('video').setProperty('mute', true);
    await getBackend('video').setProperty('speed', cfg.get('speed') ?? 1.0);

    // 文件加载由渲染端的 boot() 通过 IPC 触发，loadFile 会等待 mpv 就绪
  } catch (err) {
    console.error('[mpv] 启动失败:', err.message);
    const detail = err.message.includes('提前退出')
      ? '无法初始化 mpv 视频渲染上下文。常见原因：远程桌面/无显卡驱动、D3D11 不可用、或嵌入窗口被隐藏。已自动尝试 d3d11/gpu-auto/opengl/纯音频 四种模式均失败。'
      : err.message;
    sendToRenderer('player:error', { message: `mpv 启动失败: ${detail}` });
    throw err;
  }
}

/* ------------------------------------------------------------------ */

module.exports = { setCtx, resolveMpvPath, createMpvBackend, startMpv };
