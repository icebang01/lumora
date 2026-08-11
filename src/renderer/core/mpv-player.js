/**
 * MpvPlayer —— 基于 mpv 后端的播放器状态机。
 *
 * 继承 PlaybackEngine（src/renderer/core/engine.js），共享属性表、
 * 兼容桩与通用 helper；本文件只保留 mpv 特定的 IPC 交互逻辑。
 * 对外接口与 MediaFoundationEngine 一致，app.js / osc.js / stats.js 改动最小。
 * 不再需要的子系统（Transport/AudioOutput/MasterClock/FrameQueue/VideoRenderer）
 * 用基类兼容桩替代，保证 stats 面板不会 NPE。
 */

import { fmtTime, trackLabel } from './player.js';
import { PlaybackEngine } from './engine.js';

// Lumen 属性名 → mpv 属性名的映射。未列出的同名直传。
const MPV_PROP_MAP = {
  'scaler': 'scale',
  // 其余属性名一致：volume, mute, speed, pause, brightness, contrast,
  // saturation, gamma, video-zoom, video-pan-x, video-pan-y, video-rotate,
  // deband, tone-mapping, hwdec, loop-file
};

// mpv 属性名 → Lumen 属性名（反向映射，用于接收 mpv 推送）
const LUMEN_PROP_MAP = {
  'scale': 'scaler',
};

// 应用级命令（非 mpv 原生）：这些命令不是 mpv 能识别的，必须交回主命令总线
// runCommand 处理（app.js 监听 player 的 'app-command' 事件）。与 player.js
// 的语义保持一致，确保 OSC 按钮 / 脚本下发的切换模式、打开文件等指令可达。
const APP_COMMANDS = new Set([
  'open-file', 'open-network-stream', 'show-keymap',
  'pip', 'loop-mode-cycle', 'loop-mode-set', 'toggle-theme',
]);

export class MpvPlayer extends PlaybackEngine {
  /**
   * @param {'video'|'music'} source 该播放器实例服务的引擎。
   *   'video' → 视频引擎（带画面）；'music' → 音乐引擎（纯音频）。
   *   实例只订阅/发送匹配 source 的事件与命令，两个实例互不串扰。
   */
  constructor(source = 'video') {
    super(); // 基类初始化 props / observers / stats / abLoop / 兼容桩 / 通用状态
    this.source = source;
  }

  /* ================= 生命周期 ================= */

  async init(bootstrap) {
    this.bootstrap = bootstrap;
    const cfg = bootstrap.config.values;

    // 用配置初始化属性
    this.setProperty('volume', cfg.volume, true);
    this.setProperty('mute', cfg.mute, true);
    this.setProperty('scaler', cfg.scaler, true);
    this.setProperty('deband', cfg.deband, true);
    this.setProperty('tone-mapping', cfg['tone-mapping'], true);
    this.setProperty('target-peak', cfg['target-peak'], true);
    this.setProperty('brightness', cfg.brightness, true);
    this.setProperty('contrast', cfg.contrast, true);
    this.setProperty('saturation', cfg.saturation, true);
    this.setProperty('gamma', cfg.gamma, true);
    this.setProperty('hwdec', cfg.hwdec, true);
    this.setProperty('loop-file', cfg['loop-file'], true);

    // 监听 mpv 推来的属性变化（仅处理本引擎 source 的事件）
    window.lumen.on('mpv:property', ({ name, value, source }) => {
      if (source && source !== this.source) return;
      this._onMpvProperty(name, value);
    });

    // 监听 mpv 事件（同上，按 source 过滤）
    window.lumen.on('mpv:event', ({ type, data, source }) => {
      if (source && source !== this.source) return;
      this._onMpvEvent(type, data);
    });

    this.audio.ready = true;
    return this;
  }

  /* ================= 属性系统 ================= */

  /**
   * 写属性。mpv 管理的属性会同时发给 mpv，本地也立刻更新以保持 UI 响应。
   */
  setProperty(name, value, silent = false) {
    const old = this.props[name];

    switch (name) {
      case 'pause': {
        const v = !!value;
        this.props.pause = v;
        if (!v && this.props['idle-active'] && this.props.path) {
          // 停止后（mpv 已卸载文件，set pause false 无效）点播放
          // → 从头重新加载。resumeFromStart=true 跳过续播位置读取。
          this.props['idle-active'] = false;
          this.props['eof-reached'] = false;
          window.lumen.load(this.props.path, { resumeFromStart: true, source: this.source });
        } else {
          this._mpvSet('pause', v);
        }
        break;
      }
      case 'volume': {
        const v = Math.max(0, Math.min(Number(value) || 0, 150));
        this.props.volume = v;
        this._mpvSet('volume', v);
        break;
      }
      case 'mute':
        this.props.mute = !!value;
        this._mpvSet('mute', !!value);
        break;
      case 'speed': {
        const v = Math.max(0.05, Math.min(Number(value) || 1, 16));
        if (Math.abs(v - this.props.speed) < 1e-6) return;
        this.props.speed = v;
        this._mpvSet('speed', v);
        break;
      }
      case 'fullscreen':
        this.props.fullscreen = !!value;
        if (!silent) window.lumen.windowCommand('fullscreen', !!value);
        break;
      case 'ontop':
        this.props.ontop = !!value;
        window.lumen.windowCommand('ontop', !!value);
        break;
      case 'scaler':
        this.props.scaler = value;
        this.renderer.scalerLabel = this._scalerLabel(value);
        this._mpvSet('scale', value);
        this.needsRedraw = true;
        break;
      case 'deband':
        this.props.deband = !!value;
        this._mpvSet('deband', !!value);
        this.needsRedraw = true;
        break;
      case 'tone-mapping':
        this.props['tone-mapping'] = value;
        this._mpvSet('tone-mapping', value);
        this.needsRedraw = true;
        break;
      case 'target-peak': {
        const v = Math.max(1, Math.min(Number(value) || 203, 10000));
        this.props['target-peak'] = v;
        this._mpvSet('target-peak', v);
        this.needsRedraw = true;
        break;
      }
      case 'brightness': case 'contrast': case 'saturation': case 'gamma': {
        const v = Math.max(-100, Math.min(Number(value) || 0, 100));
        this.props[name] = v;
        this._mpvSet(name, v);
        this.needsRedraw = true;
        break;
      }
      case 'video-rotate': {
        const v = ((Number(value) % 360) + 360) % 360;
        this.props['video-rotate'] = v;
        this._mpvSet('video-rotate', v);
        this.needsRedraw = true;
        break;
      }
      case 'video-zoom': {
        const v = Math.max(0.1, Math.min(Number(value) || 1, 10));
        this.props['video-zoom'] = v;
        this._mpvSet('video-zoom', v);
        this.needsRedraw = true;
        break;
      }
      case 'video-pan-x': case 'video-pan-y': {
        const v = Math.max(-2, Math.min(Number(value) || 0, 2));
        this.props[name] = v;
        this._mpvSet(name, v);
        this.needsRedraw = true;
        break;
      }
      case 'hwdec': {
        // Lumen 的 'auto' 映射到 mpv 的 'auto-safe'
        this.props.hwdec = value;
        const mpvVal = value === 'auto' ? 'auto-safe' : value;
        window.lumen.mpvSetProperty('hwdec', mpvVal, this.source);
        break;
      }
      case 'aid': {
        this.props.aid = Number(value);
        // 0-based → mpv 1-based；-1 = 关闭
        const mpvId = value < 0 ? 'no' : String(Number(value) + 1);
        window.lumen.mpvSetProperty('aid', mpvId, this.source);
        break;
      }
      case 'vid': {
        this.props.vid = Number(value);
        const mpvId = value < 0 ? 'no' : String(Number(value) + 1);
        window.lumen.mpvSetProperty('vid', mpvId, this.source);
        break;
      }
      case 'sid': {
        this.props.sid = Number(value);
        const mpvId = value < 0 ? 'no' : String(Number(value) + 1);
        window.lumen.mpvSetProperty('sid', mpvId, this.source);
        break;
      }
      case 'sid2': {
        // 第二字幕轨（双字幕）：mpv 属性 secondary-sid，0-based → 1-based
        this.props.sid2 = Number(value);
        const mpvId = value < 0 ? 'no' : String(Number(value) + 1);
        window.lumen.mpvSetProperty('secondary-sid', mpvId, this.source);
        break;
      }
      /* ---- 字幕外观（两个引擎共用同一套 sub-* 配置键）---- */
      case 'sub-font-size': {
        const v = Math.max(1, Math.min(Number(value) || 55, 200));
        this.props['sub-font-size'] = v;
        window.lumen.mpvSetProperty('sub-font-size', v, this.source);
        break;
      }
      case 'sub-color': {
        const v = String(value || '#FFFFFF');
        this.props['sub-color'] = v;
        window.lumen.mpvSetProperty('sub-color', v, this.source);
        break;
      }
      case 'sub-bold': {
        const v = !!value;
        this.props['sub-bold'] = v;
        window.lumen.mpvSetProperty('sub-bold', v ? 'yes' : 'no', this.source);
        break;
      }
      case 'sub-outline-size': {
        const v = Math.max(0, Math.min(Number(value) || 0, 16));
        this.props['sub-outline-size'] = v;
        window.lumen.mpvSetProperty('sub-outline-size', v, this.source);
        break;
      }
      case 'sub-outline-color': {
        const v = String(value || '#000000');
        this.props['sub-outline-color'] = v;
        window.lumen.mpvSetProperty('sub-outline-color', v, this.source);
        break;
      }
      case 'sub-shadow-size': {
        // Lumen 的 sub-shadow-size(px) → mpv 的 sub-shadow-offset(px)
        const v = Math.max(0, Math.min(Number(value) || 0, 16));
        this.props['sub-shadow-size'] = v;
        window.lumen.mpvSetProperty('sub-shadow-offset', v, this.source);
        break;
      }
      case 'sub-bg': {
        this.props['sub-bg'] = !!value;
        this._applyMpvSubBack();
        break;
      }
      case 'sub-bg-color': {
        this.props['sub-bg-color'] = String(value || '#000000');
        this._applyMpvSubBack();
        break;
      }
      case 'sub-bg-opacity': {
        const v = Math.max(0, Math.min(Number(value) != null ? Number(value) : 50, 100));
        this.props['sub-bg-opacity'] = v;
        this._applyMpvSubBack();
        break;
      }
      case 'sub-pos': {
        // 0=顶 100=底，与 mpv sub-pos 语义一致
        const v = Math.max(5, Math.min(Number(value) != null ? Number(value) : 88, 95));
        this.props['sub-pos'] = v;
        window.lumen.mpvSetProperty('sub-pos', v, this.source);
        break;
      }
      case 'sub-codepage': {
        const v = String(value || '') || 'auto';
        this.props['sub-codepage'] = v;
        window.lumen.mpvSetProperty('sub-codepage', v, this.source);
        break;
      }
      case 'sub-delay': {
        // config 单位 ms；mpv 用秒。同时作用于主/副字幕轨，保持双语同步一致
        const v = Number(value) || 0;
        this.props['sub-delay'] = v;
        window.lumen.mpvSetProperty('sub-delay', v / 1000, this.source);
        window.lumen.mpvSetProperty('secondary-sub-delay', v / 1000, this.source);
        break;
      }
      case 'window-scale':
        this.props['window-scale'] = Number(value);
        window.lumen.windowCommand('scale', Number(value));
        break;
      case 'loop-file':
        this.props['loop-file'] = value;
        this._mpvSet('loop-file', value);
        break;
      default:
        this.props[name] = value;
    }

    if (!silent && old !== this.props[name]) {
      this._notify(name, this.props[name]);
    }
  }

  /* ================= mpv 通信 ================= */

  /**
   * 发送属性设置到 mpv。属性名经过映射表转换。
   */
  _mpvSet(name, value) {
    const mpvName = MPV_PROP_MAP[name] || name;
    window.lumen.mpvSetProperty(mpvName, value, this.source);
  }

  /**
   * 把 sub-bg / sub-bg-color / sub-bg-opacity 合成 mpv 的 --sub-back-color
   * （格式 #RRGGBBAA）。sub-bg 关闭时设为全透明。
   */
  _applyMpvSubBack() {
    if (!this.props['sub-bg']) {
      window.lumen.mpvSetProperty('sub-back-color', '#00000000', this.source);
      return;
    }
    const c = this.props['sub-bg-color'] || '#000000';
    const hex = (typeof c === 'string' && c.length === 7) ? c : '#000000';
    const op = Math.max(0, Math.min(100, Number(this.props['sub-bg-opacity'] != null ? this.props['sub-bg-opacity'] : 50))) / 100;
    const a = Math.round(op * 255).toString(16).padStart(2, '0');
    window.lumen.mpvSetProperty('sub-back-color', hex + a, this.source);
  }

  /**
   * 接收 mpv 推来的属性变化，同步到本地属性表。
   */
  _onMpvProperty(mpvName, value) {
    // 反向映射到 Lumen 属性名
    const lumenName = LUMEN_PROP_MAP[mpvName] || mpvName;

    // 轨道 ID：mpv 1-based → Lumen 0-based
    if (mpvName === 'vid' || mpvName === 'aid' || mpvName === 'sid') {
      const v = (value === false || value === 0 || value === 'no') ? -1 : value - 1;
      this.props[lumenName] = v;
      this._notify(lumenName, v);
      return;
    }
    if (mpvName === 'secondary-sid') {
      // 第二字幕轨：mpv 1-based → Lumen 0-based
      const v = (value === false || value === 0 || value === 'no') ? -1 : value - 1;
      this.props.sid2 = v;
      this._notify('sid2', v);
      return;
    }

    // 更新本地属性
    const old = this.props[lumenName];
    this.props[lumenName] = value;

    // 同步派生属性
    if (mpvName === 'time-pos') {
      this._notify('time-pos', value);
      this._notify('percent-pos', this.getProperty('percent-pos'));
      // 定期回报主进程，用于退出时保存续播位置
      const now = performance.now();
      if (now - this._lastReport > 2000) {
        this._lastReport = now;
        window.lumen.reportTime(value);
      }
    } else if (mpvName === 'duration') {
      this._notify('duration', value);
    } else if (old !== value) {
      this._notify(lumenName, value);
    }

    // 更新统计桩
    if (mpvName === 'estimated-vf-fps') {
      this.fps = Math.max(value || 25, 1);
      this.frameDuration = 1 / this.fps;
    } else if (mpvName === 'avsync') {
      this.stats.avSync = value || 0;
    } else if (mpvName === 'drop-frame-count') {
      this.queue.dropped = value || 0;
    } else if (mpvName === 'video-params' || mpvName === 'video-out-params') {
      if (value && value.w) {
        this.videoTrackInfo = {
          width: value.w,
          height: value.h,
          pixfmt: value.pixelformat || value['pixel-format'] || '',
        };
        this.renderer.srcWidth = value.w;
        this.renderer.srcHeight = value.h;
        this.renderer.pixfmt = this.videoTrackInfo.pixfmt;
        this.renderer.hasFrame = true;
        // 输出已配置到真实帧：这是“帧真正画到 VO”的确定性信号，比 vo-reconfig +
        // time-pos 计时更可靠。派发 frame-ready 供 idle.js 的加载遮罩据此撤下，
        // 彻底消除双引擎扰动后“遮罩早于真实首帧撤下露黑底”的回归。
        this.dispatchEvent(new CustomEvent('frame-ready'));
      }
    } else if (mpvName === 'audio-params') {
      this.audio.enabled = !!value;
    } else if (mpvName === 'hwdec-current') {
      this.renderer.rendererInfo = {
        ...this.renderer.rendererInfo,
        renderer: value ? `mpv (gpu, ${value})` : 'mpv (gpu)',
      };
    }
  }

  _onMpvEvent(type, data) {
    switch (type) {
      case 'file-loaded':
        this.dispatchEvent(new CustomEvent('loaded', { detail: { info: this.info } }));
        break;
      case 'vo-reconfig':
        // 窗口缩放 / 载入新文件触发：加载遮罩靠它判断 VO 是否已稳定，避免首帧黑闪。
        this.dispatchEvent(new CustomEvent('vo-reconfig'));
        break;
      case 'end-file':
        if (data && data.reason === 'eof') {
          // 播放结束
          if (this.props['loop-file'] === 'inf') break;
          this.props['eof-reached'] = true;
          this._notify('eof-reached', true);
          this.dispatchEvent(new CustomEvent('eof'));
        }
        break;
      case 'idle':
        this.props['idle-active'] = true;
        this._notify('idle-active', true);
        // 停止（mpv stop 卸载文件）或播放结束回 idle：统一标记 eof-reached，
        // 并把本地 pause 置 true，让播放按钮显示"播放"图标（点它重新开始）。
        // 启动时初始 idle 事件 props.path 尚不存在，不会误触发。
        if (this.props.path) {
          this.props['eof-reached'] = true;
          this._notify('eof-reached', true);
          this.props.pause = true;
          this._notify('pause', true);
        }
        break;
    }
  }

  /* ================= 命令分发 ================= */

  command(args) {
    if (!Array.isArray(args) || !args.length) return null;
    const cmd = String(args[0]);
    const a = args.slice(1);

    switch (cmd) {
      case 'set':
        this.setProperty(a[0], this._coerce(a[0], a[1]));
        return true;

      case 'add': {
        if (a[0] === 'chapter') {
          this.seekChapter(Number(a[1]) < 0 ? -1 : 1);
          return true;
        }
        const cur = Number(this.getProperty(a[0])) || 0;
        this.setProperty(a[0], cur + (Number(a[1]) || 1));
        return true;
      }

      case 'multiply': {
        const cur = Number(this.getProperty(a[0])) || 0;
        this.setProperty(a[0], cur * (Number(a[1]) || 1));
        return true;
      }

      case 'cycle': {
        const name = a[0];
        const cur = this.getProperty(name);
        if (typeof cur === 'boolean') {
          this.setProperty(name, !cur);
        } else if (name === 'audio' || name === 'video' || name === 'sub') {
          this._cycleTrack(name, a[1] === 'down' ? -1 : 1);
        } else if (name === 'hwdec') {
          this.setProperty('hwdec', this.props.hwdec === 'no' ? 'auto' : 'no');
        } else if (name === 'stats') {
          this.setProperty('stats', !this.props.stats);
        } else if (name === 'osd-level') {
          this.setProperty('osd-level', (Number(cur) + 1) % 4);
        } else if (name === 'deband') {
          this.setProperty('deband', !this.props.deband);
        }
        return true;
      }

      case 'cycle-values': {
        const name = a[0];
        const values = a.slice(1);
        const cur = String(this.getProperty(name));
        let idx = values.findIndex((v) => String(v) === cur);
        idx = (idx + 1) % values.length;
        this.setProperty(name, this._coerce(name, values[idx]));
        return true;
      }

      case 'seek': {
        const amount = Number(a[0]) || 0;
        const mode = a[1] || 'relative';
        let target;
        if (mode.startsWith('absolute-percent')) {
          target = (this.props.duration * amount) / 100;
        } else if (mode.startsWith('absolute')) {
          target = amount;
        } else {
          target = this.props['time-pos'] + amount;
        }
        this.seek(target);
        return true;
      }

      case 'frame-step':
        window.lumen.mpvCommand(['frame-step'], this.source);
        return true;

      case 'frame-back-step':
        window.lumen.mpvCommand(['frame-back-step'], this.source);
        return true;

      case 'screenshot':
        this.dispatchEvent(new CustomEvent('screenshot-request', { detail: { mode: a[0] || 'video' } }));
        return true;

      case 'quit':
        window.lumen.windowCommand('close');
        return true;

      case 'quit-watch-later':
        window.lumen.reportTime(this.props['time-pos']);
        window.lumen.windowCommand('close');
        return true;

      case 'ab-loop':
        this._cycleAbLoop();
        return true;

      case 'reset-video-eq':
        for (const k of ['brightness', 'contrast', 'saturation', 'gamma']) {
          this.setProperty(k, 0);
        }
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '画面参数已重置' } }));
        return true;

      case 'reset-pan-zoom':
        this.setProperty('video-zoom', 1);
        this.setProperty('video-pan-x', 0);
        this.setProperty('video-pan-y', 0);
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '缩放平移已重置' } }));
        return true;

      case 'show-progress':
        this.dispatchEvent(new CustomEvent('show-progress'));
        return true;

      case 'show-text':
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: a.join(' ') } }));
        return true;

      case 'show-playlist':
      case 'playlist-next':
      case 'playlist-prev':
        this.dispatchEvent(new CustomEvent('playlist', { detail: { action: cmd } }));
        return true;

      case 'script-binding':
        this.dispatchEvent(new CustomEvent('script-binding', { detail: { name: a[0] } }));
        return true;

      case 'loadfile':
        this.dispatchEvent(new CustomEvent('loadfile', { detail: { path: a[0] } }));
        return true;

      default:
        // 应用级命令（切换模式 / 打开文件 / 主题 等）不是 mpv 原生命令，
        // 交回主命令总线 runCommand 处理（app.js 监听 'app-command' 事件）。
        if (APP_COMMANDS.has(cmd)) {
          this.dispatchEvent(new CustomEvent('app-command', { detail: { args } }));
          return true;
        }
        // 其余未知命令直接转发给 mpv，让 mpv 自己处理
        window.lumen.mpvCommand(args, this.source).catch((e) => console.warn('[mpv] command error:', e.message));
        return true;
    }
  }

  _cycleTrack(kind, dir) {
    if (!this.info) return;
    if (kind === 'audio') {
      const n = this.info.audio.length;
      if (n <= 1) {
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '只有一条音轨' } }));
        return;
      }
      const next = (this.props.aid + dir + n) % n;
      this.setProperty('aid', next);
      const t = this.info.audio[next];
      this.dispatchEvent(new CustomEvent('osd', {
        detail: { text: `音轨 ${next + 1}/${n}`, value: trackLabel(t) },
      }));
    } else if (kind === 'video') {
      const n = this.info.video.length;
      if (n <= 1) return;
      const next = (this.props.vid + dir + n) % n;
      this.setProperty('vid', next);
    } else if (kind === 'sub') {
      const n = this.info.subtitle.length;
      if (n === 0) {
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: '没有字幕轨' } }));
        return;
      }
      let next = this.props.sid + dir;
      if (next >= n) next = -1;
      if (next < -1) next = n - 1;
      this.setProperty('sid', next);
      this.dispatchEvent(new CustomEvent('osd', {
        detail: {
          text: '字幕',
          value: next === -1 ? '关闭' : trackLabel(this.info.subtitle[next]),
        },
      }));
    }
  }

  _cycleAbLoop() {
    const t = this.props['time-pos'];
    if (this.abLoop.a === null) {
      this.abLoop.a = t;
      this.dispatchEvent(new CustomEvent('osd', { detail: { text: 'A-B 循环', value: `起点 ${fmtTime(t)}` } }));
    } else if (this.abLoop.b === null) {
      if (t <= this.abLoop.a) {
        this.dispatchEvent(new CustomEvent('osd', { detail: { text: 'B 点必须在 A 点之后' } }));
        return;
      }
      this.abLoop.b = t;
      this.dispatchEvent(new CustomEvent('osd', { detail: { text: 'A-B 循环', value: `${fmtTime(this.abLoop.a)} → ${fmtTime(t)}` } }));
      // 设置 mpv 的 AB-loop
      window.lumen.mpvSetProperty('ab-loop-a', this.abLoop.a, this.source);
      window.lumen.mpvSetProperty('ab-loop-b', this.abLoop.b, this.source);
    } else {
      this.abLoop = { a: null, b: null };
      window.lumen.mpvSetProperty('ab-loop-a', 0, this.source);
      window.lumen.mpvSetProperty('ab-loop-b', 0, this.source);
      this.dispatchEvent(new CustomEvent('osd', { detail: { text: 'A-B 循环已清除' } }));
    }
    this.dispatchEvent(new CustomEvent('ab-loop-change', { detail: this.abLoop }));
  }

  /* ================= 载入与跳转 ================= */

  onLoaded(payload) {
    this.info = payload.info;
    this.props['idle-active'] = false;
    this.props.duration = payload.info.duration;
    this.props.path = payload.info.path;
    this.props.filename = payload.info.path.split(/[\\/]/).pop();
    this.props['media-title'] = payload.info.title || this.props.filename;
    this.props.aid = 0;
    this.props.vid = 0;
    this.props.sid = -1;
    this.props.sid2 = -1;
    this.props['eof-reached'] = false;
    this.abLoop = { a: null, b: null };

    // 视频轨道信息（来自 ffprobe，用于 stats 面板）
    const v = this.info.video[0];
    if (v) {
      this.videoTrackInfo = {
        width: v.width,
        height: v.height,
        pixfmt: v.pixfmt,
        colorSpace: v.colorSpace,
        colorRange: v.colorRange,
        hdrType: v.hdrType,
        hdr: v.hdr,
      };
      this.fps = v.fps || 25;
      this.frameDuration = 1 / Math.max(this.fps, 1);
      this.renderer.srcWidth = v.width;
      this.renderer.srcHeight = v.height;
      this.renderer.hasFrame = true;
    }

    this.audio.enabled = payload.info.hasAudio;

    // 载入即播放
    this.setProperty('pause', false);

    for (const k of ['duration', 'filename', 'media-title', 'path', 'idle-active']) {
      this._notify(k, this.getProperty(k));
    }

    // 续播位置
    if (payload.resumeAt && payload.resumeAt > 5) {
      this.seek(payload.resumeAt);
    }
  }

  async seek(target) {
    if (!this.info) return;
    const d = this.props.duration;
    const t = Math.max(0, d > 0 ? Math.min(target, d - 0.05) : target);

    this.props['time-pos'] = t;
    this._notify('time-pos', t);
    this._notify('percent-pos', this.getProperty('percent-pos'));

    // 通知上层“正在跳转”，让首帧等待逻辑在真正到达目标位置前不撤遮罩，
    // 避免跳转（含续播跳转）解码期间露出 videoWin 黑底。
    this.dispatchEvent(new CustomEvent('seeking', { detail: { target: t } }));

    await window.lumen.seek(t, this.source);
  }

  frameStep(dir) {
    if (!this.info) return;
    if (dir > 0) {
      this.setProperty('pause', true);
      window.lumen.mpvCommand(['frame-step'], this.source);
    } else {
      this.setProperty('pause', true);
      window.lumen.mpvCommand(['frame-back-step'], this.source);
    }
  }

  /* ================= 工具 ================= */

  _scalerLabel(v) {
    const labels = {
      bilinear: '双线性（最快）',
      bicubic: '双三次',
      spline36: 'Spline36',
      ewa_lanczos: 'EWA Lanczos（最佳）',
    };
    return labels[v] || v;
  }

  seekChapter(dir) {
    if (!this.info || !this.info.chapters.length) {
      this.seek(this.props['time-pos'] + dir * 300);
      return;
    }
    const cur = this._currentChapter();
    let next = cur + dir;
    if (dir < 0 && cur >= 0 && this.props['time-pos'] - this.info.chapters[cur].start > 3) {
      next = cur;
    }
    next = Math.max(0, Math.min(next, this.info.chapters.length - 1));
    const ch = this.info.chapters[next];
    this.seek(ch.start);
    this.dispatchEvent(new CustomEvent('osd', {
      detail: { text: `章节 ${next + 1}/${this.info.chapters.length}`, value: ch.title },
    }));
  }
}
