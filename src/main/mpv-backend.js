'use strict';
/**
 * MPV 后端 —— 通过 --wid 将 mpv 嵌入 Electron 窗口，用 JSON IPC 遥控。
 *
 * 与旧的 FFmpeg 解码管线相比，mpv 自己管理解码、音频输出、视频渲染和
 * 音画同步。我们只负责：把文件喂给它、把用户的操作翻译成 IPC 命令、
 * 把它的状态变化转发给渲染端 UI。
 *
 * 关键架构差异：
 *   旧管线：ffmpeg → WebSocket → 渲染进程 (WebGL/AudioWorklet/Clock)
 *   mpv：   mpv 进程内完成一切 → IPC 属性变化 → 渲染端 UI 更新
 *
 * 8K 视频不再受 WebSocket 帧大小限制，因为 mpv 直接在 GPU 上解码和渲染，
 * 不需要跨进程传输原始 YUV 数据。
 */

const { spawn } = require('child_process');
const net = require('net');
const EventEmitter = require('events');

class MpvBackend extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mpvPath = opts.mpvPath;
    this.config = opts.config || null;
    // mode: 'video'（默认，带 GPU 变体 + 纯音频兜底）
    //       'audio'（音乐引擎：专职纯音频，--vo=null、不传 --wid、跳过所有 GPU 变体）
    // 注意：'audio' 是「主动音频模式」，与 video 引擎在 GPU 全部失败后的
    // 'audio-only' 兜底不同——前者是设计意图（音乐不需要画面），后者是降级。
    // 音乐模式已移除(2026-08-07),恒为视频引擎
    this.pipeName = `\\\\.\\pipe\\lumen-mpv-${process.pid}`;
    this.proc = null;
    this.pipe = null;
    this.requestId = 0;
    this.pending = new Map();
    this.observedProps = new Map(); // name → observe_id
    this.ready = false;
    this.buffer = '';
    this.currentPath = null;
  }

  cursorAutohide() {
    if (!this.config) return 'no';
    const v = this.config.get('cursor-autohide');
    if (v === false || v === 0 || v === 'no' || v === '0') return 'no';
    if (v === true || v === 'yes' || v === '1') return '1000';
    return String(Math.max(0, Number(v) || 0));
  }

  /**
   * 启动 mpv 子进程并连接 IPC 管道。
   *
   * --wid 让 mpv 把视频输出嵌入到 Electron 窗口的 HWND 里，
   * mpv 创建一个子窗口负责 GPU 渲染，Electron 的 HTML/CSS 覆盖在上面。
   *
   * 健壮性策略：
   *   1. 依次尝试 d3d11 → auto → opengl → null（纯音频）四种 GPU 模式；
   *   2. 如果 mpv 在管道连好前就退出，会抛出包含退出码和 stderr 的错误；
   *   3. 所有模式都失败时才向 UI 层报告致命错误。
   */
  async start(hwnd) {
    // 音频引擎不需要窗口句柄（不渲染画面，无 --wid）
    const wid = (hwnd != null) ? this._formatWid(hwnd) : null;
    const variants = this._buildStartVariants(wid);
    let lastErr = null;

    for (const { name, args, pipeName } of variants) {
      console.log(`[mpv] 尝试启动模式: ${name}`);
      try {
        await this._tryStart(args, pipeName);
        console.log(`[mpv] 启动成功: ${name}`);
        this.activeMode = name;
        this.pipeName = pipeName;
        this.ready = true;
        this._observeDefaults();
        this.emit('ready');
        return;
      } catch (err) {
        console.warn(`[mpv] 模式 ${name} 失败:`, err.message);
        lastErr = err;
        this._cleanupProc();
      }
    }

    throw lastErr || new Error('所有 mpv 启动模式均失败');
  }

  /**
   * 构建启动参数变体列表。
   *
   *  - video 模式：顺序 d3d11 → gpu-auto → opengl → audio-only（GPU 全失败兜底）。
   *  - audio 模式（音乐引擎）：只有一个变体，主动纯音频（--vo=null），不传 --wid，
   *    直接跳过所有 GPU 变体；无需窗口句柄，无需渲染表面。
   *
   * 每个变体使用独立命名管道，避免 Windows 上 pipe 名冲突。
   */
  _buildStartVariants(wid) {
    // ---- 视频引擎：依次尝试 d3d11 → auto → opengl → null（纯音频兜底）----
    const base = this._baseArgs(wid);
    const variants = [
      { name: 'd3d11', args: [...base, '--gpu-api=d3d11'] },
      { name: 'gpu-auto', args: [...base] },
      { name: 'opengl', args: [...base, '--gpu-api=opengl'] },
    ];
    // 最后兜底：纯音频模式，至少让播放控制和声音可用
    // 关键：不传 --wid（不嵌入 Electron 窗口）。无 GPU 环境下 --wid 嵌入会拿不到
    // 可用的 D3D 渲染表面而让 mpv 退出码 1；纯音频模式不渲染视频，无需嵌入。
    variants.push({
      name: 'audio-only',
      args: [...base.filter((a) => !a.startsWith('--video-sync') && !a.startsWith('--wid')), '--vo=null'],
    });

    // 为每个变体注入唯一的 IPC 管道名
    let idx = 0;
    for (const v of variants) {
      const pipeName = `\\\\.\\pipe\\lumen-mpv-${process.pid}-${idx++}`;
      v.args = v.args.map((a) => (a.startsWith('--input-ipc-server=') ? `--input-ipc-server=${pipeName}` : a));
      v.pipeName = pipeName;
    }
    return variants;
  }

  /**
   * 与 mpv 启动无关的通用参数。
   * wid 为 null/undefined 时不注入 --wid（音频引擎用），否则嵌入 Electron 窗口。
   */
  _baseArgs(wid) {
    const haveWid = wid != null;
    // sub-auto / slang 是 mpv 的「启动选项」，必须在启动时通过 CLI 传入，
    // 不能走 set_property：本构建对 sub-auto 的 set_property 返回
    // "unsupported format for accessing property"，会让 startMpv 的启动配置块
    // 抛错、误报「启动失败」并中断后续属性应用。
    // mpv 的 sub-auto 合法取值只有 no/exact/fuzzy/all；历史上配置里用过
    // 'auto'、'disabled' 等非法值（来自 UI 旧选项 / 早期默认值），会触发
    // "Invalid value for option sub-auto" → mpv 启动即 Fatal 退出 → IPC 管道
    // 永远连不上 → startMpv 四模式全部「提前退出」→ 降级纯音频。这里做归一化，
    // 保证任何情况下传给 mpv 的都是合法值。
    const VALID_SUB_AUTO = ['no', 'exact', 'fuzzy', 'all'];
    const SUB_AUTO_MAP = { auto: 'fuzzy', disabled: 'no', '': 'fuzzy' };
    let subAuto = (this.config && typeof this.config.get === 'function')
      ? (this.config.get('sub-auto') || 'fuzzy') : 'fuzzy';
    subAuto = VALID_SUB_AUTO.includes(subAuto) ? subAuto : (SUB_AUTO_MAP[subAuto] || 'fuzzy');
    const slang = (this.config && typeof this.config.get === 'function')
      ? (this.config.get('slang') || '') : '';

    // 仅视频引擎需要嵌入窗口；音频引擎（wid 为 null）不传 --wid
    const widArg = haveWid ? [`--wid=${wid}`] : [];
    const opts = [
      '--no-terminal',
      '--idle=yes',
      ...widArg,
      `--input-ipc-server=${this.pipeName}`,
      // 禁用 mpv 自带的 UI 层，全部由 Lumen 的渲染端负责
      '--osc=no',
      '--osd-level=0',
      '--osd-bar=no',
      '--input-default-bindings=no',
      '--input-builtin-bindings=no',
      `--cursor-autohide=${this.cursorAutohide()}`,
      // 播放行为
      '--keep-open=yes',
      '--keep-open-pause=yes',
      // 减少相邻曲目间的音频间隙（mpv 内部队列/append 切轨时生效）；
      // 与 ffmpeg 引擎的真·重叠 crossfade 互补，覆盖 mpv 引擎路径
      '--gapless-audio=yes',
      '--hr-seek=yes',
      '--hr-seek-framedrop=yes',
      // 硬件解码：auto-safe 让 mpv 自己选最安全的硬件解码器
      '--hwdec=auto-safe',
      // ---- 缓存与预读（8K 关键）----
      '--cache=yes',
      '--demuxer-readahead-secs=20',
      // 流缓冲
      '--cache-secs=5',
      // ---- 多线程解码（8K 软解关键）----
      `--vd-lavc-threads=${this._cpuCores()}`,
      '--vd-lavc-fast=yes',
      // ---- 帧丢弃策略 ----（注意：mpv v0.41 的 framedrop 只接受 no/vo/decoder，
      // decoder+video 在该版本是非法值，会导致 mpv 启动即退出 code=1）
      '--framedrop=decoder',
      // ---- 视频同步 ----
      '--video-sync=display-resample',
      '--video-sync-max-video-change=5',
      '--video-sync-max-audio-change=0.07',
      // 减少 swapchain 延迟
      '--swapchain-depth=4',
      // 不自动下载在线视频
      '--ytdl=no',
      // 提高日志级别，方便排查启动失败原因
      '--msg-level=all=info',
      // 不加载 mpv 自己的配置文件，全部由 Lumen 管理
      '--no-config',
    ];
    // 字幕自动加载选项（CLI 传入，见上方说明）
    opts.push(`--sub-auto=${subAuto}`);
    if (slang) opts.push(`--slang=${slang}`);

    // ---- 字幕外观（与 sub-auto/slang 同理，属于启动选项，必须在 CLI 传入；
    // 运行时变更走 set_property 由 mpv-player.js 路由）----
    // 单位与 config 一致：字号/描边/阴影为 px，位置 0=顶 100=底，延迟为 ms。
    const num = (v, d) => { const x = Number(v); return (v == null || isNaN(x)) ? d : x; };
    const subFs = num(this.config.get('sub-font-size'), 55);
    if (subFs) opts.push(`--sub-font-size=${subFs}`);
    opts.push(`--sub-color=${this.config.get('sub-color') || '#FFFFFF'}`);
    opts.push(`--sub-bold=${this.config.get('sub-bold') ? 'yes' : 'no'}`);
    const subOut = num(this.config.get('sub-outline-size'), 2);
    if (subOut) opts.push(`--sub-outline-size=${subOut}`);
    opts.push(`--sub-outline-color=${this.config.get('sub-outline-color') || '#000000'}`);
    const subShadow = num(this.config.get('sub-shadow-size'), 2);
    if (subShadow) opts.push(`--sub-shadow-offset=${subShadow}`);
    // sub-pos：mpv 的 0=顶 100=底 与我们的 sub-pos 语义一致
    opts.push(`--sub-pos=${num(this.config.get('sub-pos'), 88)}`);
    const subCp = this.config.get('sub-codepage') || '';
    if (subCp) opts.push(`--sub-codepage=${subCp}`);
    // sub-delay：config 单位是 ms，mpv 用秒
    const subDelay = num(this.config.get('sub-delay'), 0);
    if (subDelay) opts.push(`--sub-delay=${subDelay / 1000}`);
    // 字幕底衬（带透明度）：mpv 用 --sub-back-color，格式 #RRGGBBAA
    if (this.config.get('sub-bg')) {
      const bgColor = this.config.get('sub-bg-color') || '#000000';
      const bgHex = (typeof bgColor === 'string' && bgColor.length === 7) ? bgColor : '#000000';
      const bgOp = Math.max(0, Math.min(100, num(this.config.get('sub-bg-opacity'), 50))) / 100;
      const bgA = Math.round(bgOp * 255).toString(16).padStart(2, '0');
      opts.push(`--sub-back-color=${bgHex}${bgA}`);
    }
    return opts;
  }

  /**
   * 单次启动尝试。等待 IPC 管道就绪；如果 mpv 提前退出，抛出包含 stderr 的错误。
   */
  async _tryStart(args, pipeName) {
    let stderrBuf = '';
    let exited = false;

    this.proc = spawn(this.mpvPath, args, {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // mpv stderr: raw buffer → UTF-8 解码（mpv 现代版本在 Windows 上输出 UTF-8）
    this.proc.stderr.on('data', (d) => {
      const text = typeof d === 'string' ? d : d.toString('utf8');
      stderrBuf += text;
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines) console.log(`[mpv:stderr] ${line}`);
    });

    const exitPromise = new Promise((resolve) => {
      this.proc.on('error', (e) => {
        exited = true;
        resolve({ error: e });
      });
      this.proc.on('close', (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
    });

    // 竞争：管道连上 vs 进程提前退出
    const result = await Promise.race([
      this._connectPipe(pipeName).then(() => ({ connected: true })),
      exitPromise.then((r) => ({ exited: true, ...r })),
    ]);

    if (result.exited) {
      const tail = stderrBuf.trim().split(/\r?\n/).filter(Boolean).slice(-8).join('; ');
      throw new Error(
        `mpv 提前退出 (code=${result.code ?? 'unknown'}${result.error ? `, ${result.error.message}` : ''})` +
        (tail ? `: ${tail}` : '')
      );
    }

    // 管道已连上，再挂上长期监听器
    this.pipe.on('data', (data) => this._onData(data));
    this.pipe.on('error', (e) => {
      if (this.ready) {
        console.error('[mpv] 管道错误:', e.message);
        this.emit('error', e);
      }
    });
    this.pipe.on('close', () => {
      if (this.ready) console.warn('[mpv] 管道已关闭');
    });

    this.proc.on('close', (code, signal) => {
      console.log(`[mpv] 进程退出 code=${code} signal=${signal}`);
      this.ready = false;
      this.emit('closed', { code, signal });
    });
  }

  _cleanupProc() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this.proc = null;
    if (this.pipe) {
      try { this.pipe.destroy(); } catch { /* ignore */ }
      this.pipe = null;
    }
  }

  /**
   * 把 Electron 的 getNativeWindowHandle() Buffer 转成 mpv --wid 需要的数字。
   * Windows 上 HWND 是指针大小（4 或 8 字节），值通常很小，用 BigInt 避免溢出。
   */
  _formatWid(hwndBuf) {
    const buf = Buffer.isBuffer(hwndBuf) ? hwndBuf : Buffer.from(hwndBuf);
    if (buf.length <= 4) {
      return String(buf.readUInt32LE(0));
    }
    return buf.readBigUInt64LE(0).toString();
  }

  /**
   * 返回 CPU 物理核心数，用于多线程解码参数。
   * 8K 软解码需要尽可能多的线程，但超线程的收益递减，取物理核心数即可。
   */
  _cpuCores() {
    try {
      const cpus = require('os').cpus();
      if (!cpus || !cpus.length) return 4;
      // Windows: os.cpus() 返回逻辑核心数，粗略折半得物理核心
      // 如果已经是 4 核或更少，全用上
      const logical = cpus.length;
      if (logical <= 4) return logical;
      return Math.max(4, Math.floor(logical / 2));
    } catch {
      return 4;
    }
  }

  /**
   * 连接到 mpv 创建的命名管道。
   * mpv 启动后需要一小段时间才能创建管道，这里重试等待。
   */
  async _connectPipe(pipeName = this.pipeName) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        this.pipe = net.connect(pipeName);

        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect timeout')), 300);
          this.pipe.once('connect', () => { clearTimeout(timer); resolve(); });
          this.pipe.once('error', (e) => { clearTimeout(timer); reject(e); });
        });

        console.log('[mpv] IPC 管道已连接');
        return;
      } catch (e) {
        // mpv 还没创建好管道，等一下再试
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('无法连接到 mpv IPC 管道（重试 100 次后超时）');
  }

  /* ---------------------------------------------------------------- */
  /* JSON IPC 协议                                                     */
  /* ---------------------------------------------------------------- */

  _onData(data) {
    this.buffer += data.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch (e) {
        console.warn('[mpv] JSON 解析失败:', line.slice(0, 200));
      }
    }
  }

  _handleMessage(msg) {
    if (msg.event) {
      this._handleEvent(msg);
    } else if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
      const { resolve, reject, timer } = this.pending.get(msg.request_id);
      this.pending.delete(msg.request_id);
      clearTimeout(timer);
      if (msg.error && msg.error !== 'success') {
        reject(new Error(msg.error));
      } else {
        resolve(msg.data);
      }
    }
  }

  _handleEvent(msg) {
    switch (msg.event) {
      case 'property-change':
        this.emit('property', { name: msg.name, value: msg.data });
        break;
      case 'file-loaded':
        this.emit('file-loaded');
        break;
      case 'end-file':
        this.emit('end-file', { reason: msg.reason, playlist_pos: msg.playlist_insert_id });
        break;
      case 'idle':
        this.emit('idle');
        break;
      case 'vo-reconfig':
        // 窗口缩放 / 载入新文件都会触发一次或多次：遮罩撤下逻辑靠它判断
        // “VO 是否已稳定到最终尺寸”，从而盖住 DWM 缩放动画拖尾导致的延迟黑帧。
        this.emit('vo-reconfig');
        break;
      case 'log-message':
        if (msg.level === 'error' || msg.level === 'warn') {
          console.log(`[mpv:${msg.level}] ${msg.prefix}: ${msg.text}`);
          this.emit('log', { level: msg.level, prefix: msg.prefix, text: msg.text });
        }
        break;
      case 'screenshot':
        this.emit('screenshot', { filename: msg.filename });
        break;
    }
  }

  /**
   * 发送一条 mpv JSON IPC 命令，返回 Promise。
   * 每条命令带 request_id，mpv 的应答通过同一个 id 匹配。
   */
  command(...args) {
    if (!this.pipe || !this.ready) {
      return Promise.reject(new Error('mpv 未就绪'));
    }
    const id = ++this.requestId;
    const msg = JSON.stringify({ command: args, request_id: id }) + '\n';
    this.pipe.write(msg);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`mpv 命令超时: ${JSON.stringify(args)}`));
        }
      }, 5000);

      this.pending.set(id, { resolve, reject, timer });
      this.pipe.write(msg);
    });
  }

  async setProperty(name, value) {
    return this.command('set_property', name, value);
  }

  async getProperty(name) {
    return this.command('get_property', name);
  }

  /**
   * 观察属性变化。mpv 会在属性值改变时主动推送事件。
   * id 必须全局唯一，用于 mpv 内部管理观察者。
   */
  observeProperty(name) {
    if (this.observedProps.has(name)) return;
    const id = this.observedProps.size + 1;
    this.observedProps.set(name, id);
    this.command('observe_property', id, name).catch((e) => {
      console.warn(`[mpv] 观察属性失败 ${name}:`, e.message);
    });
  }

  async loadFile(filePath, mode = 'replace') {
    this.currentPath = filePath;
    return this.command('loadfile', filePath, mode);
  }

  /**
   * 根据视频分辨率动态调整 mpv 性能参数。
   *
   * 8K (7680x4320)：GPU 几乎不可能实时做 EWA Lanczos 下采样，
   *   切到 bicubic + 开启 d3d11va 硬解 + 加大缓存。
   * 4K (3840x2160)：保持 ewa_lanczos 但确保硬解开启。
   * 1080p 及以下：默认配置即可。
   */
  async applyResolutionProfile(width, height) {
    if (!this.ready) return;
    const pixels = width * height;

    if (pixels >= 7680 * 4320 * 0.9) {
      // ---- 8K profile ----
      console.log(`[mpv] 应用 8K 性能配置 (${width}x${height})`);
      // 8K 下 EWA Lanczos 每像素需 ~441 次纹理采样，GPU 必然过载
      // 切到 bilinear（2 次采样），把 GPU 算力留给解码和色调映射
      await this._safeSet('scale', 'bilinear');
      await this._safeSet('dscale', 'bilinear');
      // 确保硬解
      await this._safeSet('hwdec', 'auto-safe');
      // 加大预读缓存
      await this._safeSet('demuxer-readahead-secs', 30);
      await this._safeSet('cache-secs', 10);
      // 关闭去带，省 GPU 算力
      await this._safeSet('deband', 'no');
      // 帧丢弃更激进
      await this._safeSet('framedrop', 'decoder');
    } else if (pixels >= 3840 * 2160 * 0.9) {
      // ---- 4K profile ----
      console.log(`[mpv] 应用 4K 性能配置 (${width}x${height})`);
      // 4K 下 EWA Lanczos 可行但边界情况可能掉帧，用 spline36 折中
      await this._safeSet('scale', 'spline36');
      await this._safeSet('dscale', 'mitchell');
      await this._safeSet('hwdec', 'auto-safe');
      await this._safeSet('demuxer-readahead-secs', 20);
      await this._safeSet('cache-secs', 5);
    } else {
      // ---- 标准 profile ----
      console.log(`[mpv] 应用标准性能配置 (${width}x${height})`);
      // 恢复用户配置的缩放算法
      await this._safeSet('scale', 'ewa_lanczos');
      await this._safeSet('dscale', 'mitchell');
      await this._safeSet('demuxer-readahead-secs', 20);
      await this._safeSet('cache-secs', 5);
    }
  }

  /** 安全设置属性，失败不中断 */
  async _safeSet(name, value) {
    try {
      await this.setProperty(name, value);
    } catch (e) {
      console.warn(`[mpv] 设置 ${name}=${value} 失败:`, e.message);
    }
  }

  async seek(time, mode = 'absolute') {
    return this.command('seek', time, mode, 'exact');
  }

  async setTrack(type, index) {
    // Lumen 用 0-based 索引，mpv 用 1-based ID
    // index < 0 表示关闭该类型轨道
    const mpvId = index < 0 ? 'no' : String(index + 1);
    const prop = type === 'video' ? 'vid' : type === 'audio' ? 'aid' : 'sid';
    return this.setProperty(prop, mpvId);
  }

  async stop() {
    return this.command('stop');
  }

  /**
   * 截图。mpv 的 screenshot 命令直接保存到文件。
   * mode: 'video' = 仅画面, 'window' = 含 OSD（mpv 不支持，等同 video）, 'subtitles' = 含字幕
   */
  async screenshot(mode = 'video') {
    const mpvMode = mode === 'subtitles' ? 'subtitles' : 'video';
    return this.command('screenshot-to-file', '', mpvMode).catch(() => {
      // screenshot-to-file 需要路径，退回 screenshot 命令（保存到默认目录）
      return this.command('screenshot', mpvMode);
    });
  }

  _observeDefaults() {
    // 两类引擎都需要的通用属性（播放状态 / 轨道 / 音频 / 章节）
    const common = [
      'time-pos', 'duration', 'pause', 'speed', 'volume', 'mute',
      'eof-reached', 'filename', 'media-title', 'idle-active',
      'percent-pos',
      // 轨道与章节
      'track-list', 'chapter', 'chapter-list',
      'vid', 'aid', 'sid',
      // 硬件解码
      'hwdec-current', 'hwdec-interop',
      // 性能统计（音频相关部分）
      'avsync', 'drop-frame-count', 'total-avsync-change',
      // 音频参数
      'audio-params', 'audio-out-params',
      // 其他
      'fullscreen', 'loop-file',
    ];
    // 仅视频引擎需要的属性（无画面时观察这些只会得到空值并产生噪音）
    const videoOnly = [
      'estimated-vf-fps', 'vo-delayed-frame-count',
      'video-params', 'video-out-params',
      'brightness', 'contrast', 'saturation', 'gamma',
      'video-zoom', 'video-pan-x', 'video-pan-y', 'video-rotate',
      'scale', 'deband', 'tone-mapping',
    ];
    const props = [...common, ...videoOnly];

    for (const p of props) {
      this.observeProperty(p);
    }
  }

  /**
   * 返回一个 Promise，在 mpv 就绪后 resolve。
   * 用于 loadFile 等场景：渲染端可能比 mpv 启动更快。
   */
  whenReady() {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.once('ready', resolve);
      this.once('error', reject);
    });
  }

  /**
   * 清理：关管道、杀进程。
   * Windows 上子进程不随父进程消亡，必须显式终止。
   */
  destroy() {
    this._cleanupProc();
  }
}

module.exports = { MpvBackend };
