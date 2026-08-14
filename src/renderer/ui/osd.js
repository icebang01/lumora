/**
 * OSD —— 屏幕提示。
 *
 * 两种形态：
 *   左上角消息条：文字反馈（音量、轨道、速度…），会自动合并同类项
 *   中央大反馈：图标脉冲（暂停、快进…），一闪而过不留痕
 *
 * "合并同类项"是这里唯一值得说的设计：连按十下音量键，用户想看到的
 * 是一条不断跳数的提示，而不是十条堆叠的消息。所以每条消息带一个
 * 归并键，同键消息就地更新并重置计时。
 */
import { escapeHtml } from '../../shared/escape-html.js';

const ICONS = {
  play:    '<path d="M8 5 L19.5 12 L8 19 Z"/>',
  pause:   '<rect x="7" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2"/>',
  forward: '<path d="M3 5 L12 12 L3 19 Z"/><path d="M12.5 5 L21.5 12 L12.5 19 Z"/>',
  backward:'<path d="M21 5 L12 12 L21 19 Z"/><path d="M11.5 5 L2.5 12 L11.5 19 Z"/>',
  volume:  '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  mute:    '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 9.5 L21 14 M21 9.5 L16.5 14" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
  stop:    '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  loop:    '<path d="M5 9a4 4 0 0 1 4-4h9M19 15a4 4 0 0 1-4 4H6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16 2.5 19.5 5 16 7.5z"/><path d="M8 16.5 4.5 19 8 21.5z"/>',
};

export class Osd {
  constructor(listEl, centerEl) {
    this.list = listEl;
    this.center = centerEl;
    this.items = new Map();   // key → { el, timer }
    this.max = 4;
    this._centerTimer = null;
    this.level = 1;           // 0 = 全关
    this._silentUntil = 0;    // 启动静默窗口：抑制 mpv 初始推送触发的 burst/message 闪现
  }

  setLevel(v) { this.level = Number(v) || 0; }

  /** 启动静默窗口：ms 毫秒内抑制 burst/message（force 消息除外）。
   *  mpv 启动后会把所有初始属性（volume/mute/speed/loop-file…）推送一遍，
   *  观察者里的 osd.burst/message 会跟着闪现"音量""静音""循环"等图标，
   *  用户看到的就是"启动时冒出一个图标"（此前 pause 单独加了首次跳过，
   *  这里统一覆盖所有属性推送）。 */
  startSilentWindow(ms) { this._silentUntil = Date.now() + ms; }

  /**
   * 显示一条消息。
   * @param {string} text  主文本
   * @param {string} [value] 高亮值（数字类反馈放这里）
   * @param {{key?:string, duration?:number, force?:boolean}} [opts]
   */
  message(text, value, opts = {}) {
    if (this.level === 0 && !opts.force) return;
    if (Date.now() < this._silentUntil && !opts.force) return;
    const key = opts.key || text;
    const duration = opts.duration || 1500;

    let item = this.items.get(key);
    if (item) {
      // 同类项就地更新，不新增一条
      item.el.innerHTML = this._html(text, value);
      clearTimeout(item.timer);
    } else {
      const el = document.createElement('div');
      el.className = 'osd-msg';
      el.innerHTML = this._html(text, value);
      this.list.appendChild(el);
      item = { el, timer: null };
      this.items.set(key, item);

      // 超量时挤掉最老的一条
      while (this.items.size > this.max) {
        const oldest = this.items.keys().next().value;
        this._remove(oldest, true);
      }
    }

    item.timer = setTimeout(() => this._remove(key), duration);
  }

  _html(text, value) {
    const t = escapeHtml(text);
    return value === undefined || value === null || value === ''
      ? t
      : `${t} <span class="osd-value">${escapeHtml(String(value))}</span>`;
  }

  _remove(key, immediate = false) {
    const item = this.items.get(key);
    if (!item) return;
    this.items.delete(key);
    clearTimeout(item.timer);
    if (immediate) { item.el.remove(); return; }
    item.el.classList.add('leaving');
    setTimeout(() => item.el.remove(), 220);
  }

  clear() {
    for (const key of [...this.items.keys()]) this._remove(key, true);
  }

  /** 清掉中央图标脉冲（暂停/快进等），并取消其自动清除定时器 */
  clearCenter() {
    if (this._centerTimer) { clearTimeout(this._centerTimer); this._centerTimer = null; }
    if (this.center) this.center.innerHTML = '';
  }

  /** 中央图标脉冲 */
  burst(icon) {
    const svg = ICONS[icon];
    if (!svg) return this.burstText(icon);
    this._showBurst(`<svg viewBox="0 0 24 24">${svg}</svg>`, false);
  }

  /** 中央文字脉冲（速度、跳转量这类） */
  burstText(text) {
    this._showBurst(escapeHtml(text), true);
  }

  _showBurst(html, wide) {
    if (this.level === 0) return;
    if (Date.now() < this._silentUntil) return;
    clearTimeout(this._centerTimer);
    this.center.innerHTML = `<div class="osd-burst${wide ? ' wide' : ''}">${html}</div>`;
    this._centerTimer = setTimeout(() => { this.center.innerHTML = ''; }, 620);
  }
}

