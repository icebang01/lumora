/**
 * PlaybackEngine —— 播放引擎抽象契约。
 *
 * 所有后端（mpv / Media Foundation / …）必须遵守同一份接口，前端的
 * OSC / stats / 键位 / 脚本才能无感切换。设计依据见 MEDIAFOUNDATION_ENGINE.md。
 *
 * 本文件提供：
 *   - PlaybackEngine：基类，封装共享属性表、兼容桩、通用派生属性计算、
 *     通用 helper（observeProperty / _notify / _coerce / _cycleAbLoop /
 *     _currentChapter / _measuredFps）。
 *
 * 路线 A（mediafoundation）已落地：渲染端复用 ffmpeg 管线同款 Player
 * （WebSocket → WebGL2），主进程由 src/main/mf/backend.js 的 MfBackend
 * 驱动原生 Media Foundation 解码，本文件不再需要占位实现。
 *
 * 引擎工厂 createEngine() 放在 app.js，避免本文件反向依赖 mpv-player.js
 * 造成循环导入。
 */

import { fmtTime, trackLabel } from './player.js';

/** 共享属性表（所有引擎一致，与 mpv 属性名对齐） */
function buildProps() {
  return {
    'pause': true,
    'time-pos': 0,
    'duration': 0,
    'percent-pos': 0,
    'volume': 100,
    'mute': false,
    'speed': 1.0,
    'filename': '',
    'media-title': '',
    'path': '',
    'fullscreen': false,
    'ontop': false,
    'idle-active': true,
    'eof-reached': false,
    'aid': 0,
    'vid': 0,
    'sid': -1,
    'chapter': -1,
    'stats': false,
    'osd-level': 1,
    'sub-visibility': true,
    'loop-file': 'no',
    'scaler': 'ewa_lanczos',
    'deband': false,
    'tone-mapping': 'bt2390',
    'hwdec': 'auto',
    'brightness': 0,
    'contrast': 0,
    'saturation': 0,
    'gamma': 0,
    'video-rotate': 0,
    'video-zoom': 1,
    'video-pan-x': 0,
    'video-pan-y': 0,
    'window-scale': 1,
  };
}

/** 兼容桩：让 osc.js / stats.js 不报错（值由后端推送更新） */
function buildStubs() {
  return {
    queue: {
      length: 0, maxSize: 12, dropped: 0, presented: 0, totalReceived: 0,
      bufferedSeconds: () => 0,
    },
    renderer: {
      gl: null,
      rendererInfo: { renderer: 'engine', floatFBO: true },
      scalerLabel: '',
      avgRenderMs: 0,
      hasFrame: false,
      pixfmt: '',
      srcWidth: 0,
      srcHeight: 0,
      texY: null,
      screenshot: () => null,
      render: () => {},
      setOption: () => {},
      configure: () => {},
    },
    audio: {
      ready: false,
      enabled: false,
      ctx: null,
      snapshot: { consumedFrames: 0 },
      mediaTime: null,
      bufferedSeconds: 0,
      workletSeconds: 0,
      pendingFrames: 0,
      overflowFrames: 0,
      underruns: 0,
    },
    transport: { connected: true, bitrate: 0, epoch: 0 },
    clock: { source: 'engine', now: () => 0 },
  };
}

export class PlaybackEngine extends EventTarget {
  constructor() {
    super();
    // 共享状态
    this.props = buildProps();
    this.observers = new Map();
    this.stats = { renderedFrames: 0, lastFrameTime: 0, frameTimes: [], avSync: 0, lastPts: 0 };
    this.abLoop = { a: null, b: null };
    this.info = null;
    this.videoTrackInfo = null;
    this.epoch = 0;
    this.fps = 25;
    this.frameDuration = 1 / 25;
    this.needsRedraw = false;
    this.voDisabled = false;
    this.voError = null;
    this._lastReport = 0;
    // 兼容桩
    Object.assign(this, buildStubs());
  }

  /* ============ 通用派生属性（引擎无关） ============ */

  getProperty(name) {
    switch (name) {
      case 'percent-pos': {
        const d = this.props.duration;
        return d > 0 ? (this.props['time-pos'] / d) * 100 : 0;
      }
      case 'time-remaining': {
        const d = this.props.duration;
        return Math.max(0, d - this.props['time-pos']);
      }
      case 'playback-time': return this.props['time-pos'];
      case 'chapter': return this._currentChapter();
      case 'chapters': return this.info ? this.info.chapters.length : 0;
      case 'core-idle': return this.props.pause || this.props['idle-active'];
      case 'estimated-vf-fps': return this._measuredFps();
      case 'drop-frame-count': return this.queue.dropped;
      default: return this.props[name];
    }
  }

  observeProperty(name, cb) {
    if (!this.observers.has(name)) this.observers.set(name, new Set());
    this.observers.get(name).add(cb);
    cb(this.getProperty(name), name);
    return () => this.observers.get(name).delete(cb);
  }

  _notify(name, value) {
    const set = this.observers.get(name);
    if (set) for (const cb of set) { try { cb(value, name); } catch (e) { console.error(e); } }
    this.dispatchEvent(new CustomEvent('property-change', { detail: { name, value } }));
  }

  _coerce(name, raw) {
    const cur = this.props[name];
    if (typeof cur === 'boolean') {
      const s = String(raw).toLowerCase();
      return s === 'yes' || s === 'true' || s === '1' || s === 'on';
    }
    if (typeof cur === 'number') {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : cur;
    }
    return raw;
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
    } else {
      this.abLoop = { a: null, b: null };
      this.dispatchEvent(new CustomEvent('osd', { detail: { text: 'A-B 循环已清除' } }));
    }
    this.dispatchEvent(new CustomEvent('ab-loop-change', { detail: this.abLoop }));
  }

  _currentChapter() {
    if (!this.info || !this.info.chapters.length) return -1;
    const t = this.props['time-pos'];
    for (let i = this.info.chapters.length - 1; i >= 0; i--) {
      if (t >= this.info.chapters[i].start) return i;
    }
    return -1;
  }

  _measuredFps() {
    return this.fps;
  }

  /* ============ 抽象契约（子类必须实现） ============ */

  async init(bootstrap) { throw new Error('PlaybackEngine.init 未实现'); }
  command(args) { throw new Error('PlaybackEngine.command 未实现'); }
  setProperty(name, value, silent = false) { throw new Error('PlaybackEngine.setProperty 未实现'); }
  onLoaded(payload) { throw new Error('PlaybackEngine.onLoaded 未实现'); }
  async seek(target) { throw new Error('PlaybackEngine.seek 未实现'); }
  frameStep(dir) { throw new Error('PlaybackEngine.frameStep 未实现'); }
}

export { fmtTime, trackLabel };
