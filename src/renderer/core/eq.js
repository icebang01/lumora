/**
 * 音频均衡器(EQ)共享状态。
 *
 * 10 段图示 EQ + 预设；状态持久化到 localStorage 并广播给所有订阅者，
 * 保证 ffmpeg 引擎(AudioOutput 的 WebAudio BiquadFilter 链)与 mpv 引擎
 * (af=equalizer)以及各 UI 面板始终同步。
 *
 * 频段采用行业标准 10 段(31Hz ~ 16kHz)，与 mpv equalizer 滤镜默认频段一致，
 * 因此同一组增益可直接用于两条引擎路径。
 */

const EQ_KEY = 'lumen:eq';

// 标准 10 段图示 EQ 中心频率(Hz)
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_MIN = -12;
export const EQ_MAX = 12;

// 预设：每个数组长度 10，元素对应该频段的增益(dB)
export const EQ_PRESETS = {
  flat:      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass:      [6, 5, 4, 2, 1, 0, 0, 0, 0, 0],
  treble:    [0, 0, 0, 0, 0, 0, 1, 3, 5, 6],
  vocal:     [0, 0, 0, -2, -1, 4, 5, 3, 0, 0],
  rock:      [4, 3, -1, 2, 1, -1, 1, 2, 3, 4],
  pop:       [-1, 1, 3, 4, 3, 0, -1, -1, 0, 1],
  classical: [4, 3, 2, -1, -1, -1, 0, 2, 3, 4],
  electronic:[5, 4, 1, 0, -2, -2, 0, 2, 4, 5],
  acoustic:  [3, 2, 1, 0, 1, 2, 3, 2, 1, 0],
  loudness:  [5, 4, 3, 2, 1, 0, 1, 2, 3, 4],
};

const DEFAULT_EQ = { enabled: false, preset: 'flat', bands: EQ_PRESETS.flat.slice() };

let _state = _load();
const _listeners = new Set();

function _clampBand(v) {
  const n = Number(v) || 0;
  return Math.max(EQ_MIN, Math.min(EQ_MAX, n));
}

function _load() {
  try {
    const raw = localStorage.getItem(EQ_KEY);
    if (!raw) return { enabled: DEFAULT_EQ.enabled, preset: DEFAULT_EQ.preset, bands: DEFAULT_EQ.bands.slice() };
    const p = JSON.parse(raw);
    const bands = (Array.isArray(p.bands) && p.bands.length === EQ_FREQS.length)
      ? p.bands.map((v) => _clampBand(v))
      : DEFAULT_EQ.bands.slice();
    return {
      enabled: !!p.enabled,
      preset: typeof p.preset === 'string' ? p.preset : 'flat',
      bands,
    };
  } catch {
    return { enabled: DEFAULT_EQ.enabled, preset: DEFAULT_EQ.preset, bands: DEFAULT_EQ.bands.slice() };
  }
}

function _persist() {
  try { localStorage.setItem(EQ_KEY, JSON.stringify(_state)); } catch { /* localStorage 不可用则仅内存 */ }
}

/** 返回当前 EQ 状态的快照(深拷贝 bands) */
export function getEq() {
  return { enabled: _state.enabled, preset: _state.preset, bands: _state.bands.slice() };
}

/**
 * 合并写入 EQ 状态并广播。
 * @param {{enabled?:boolean, preset?:string, bands?:number[]}} partial
 */
export function setEq(partial) {
  if (partial.enabled !== undefined) _state.enabled = !!partial.enabled;
  if (partial.preset !== undefined) _state.preset = partial.preset;
  if (Array.isArray(partial.bands)) {
    _state.bands = partial.bands.map((v) => _clampBand(v)).slice(0, EQ_FREQS.length);
    while (_state.bands.length < EQ_FREQS.length) _state.bands.push(0);
  }
  _persist();
  const snap = getEq();
  for (const fn of _listeners) { try { fn(snap); } catch { /* 单个订阅者异常不影响其余 */ } }
  return snap;
}

/** 套用预设并广播(同时把 bands 重置为该预设的值) */
export function applyPreset(name) {
  const p = EQ_PRESETS[name];
  if (!p) return getEq();
  return setEq({ preset: name, bands: p.slice() });
}

/** 订阅 EQ 变化，返回取消订阅函数 */
export function onEqChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * 转 mpv `af` 串：equalizer=g1:g2:...:g10。
 * 禁用或全平时返回空串，用于清空滤镜链(不引入无谓的 DSP 开销)。
 */
export function eqToMpvString(eq) {
  if (!eq || !eq.enabled) return '';
  const bands = (eq.bands || []).map((v) => Math.round(v || 0));
  if (bands.length !== EQ_FREQS.length) return '';
  if (bands.every((v) => v === 0)) return '';
  return 'equalizer=' + bands.join(':');
}
