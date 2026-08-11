/**
 * 弹幕渲染层（Canvas2D，时间驱动）。
 *
 * 设计要点：
 *  - 与播放器时钟解耦：外界每帧调用 render(now)，now 为当前媒体时间（秒）。
 *    弹幕的屏幕位置完全由"媒体时间 − 起飞时刻"推算，因此暂停时弹幕自然冻结、
 *    seek 时弹幕重排，都不会错乱 —— 这是和字幕/视频保持同步的关键。
 *  - 支持模式：1=滚动(右→左) 4=底部(停留) 5=顶部(停留) 6=逆向(左→右)。
 *    7=高级(定位) 退化为普通滚动；8=代码弹幕直接忽略。
 *  - 轨道（lane）分配：按可用区域切分等宽轨道，每条弹幕起飞前找一条不会被
 *    自己/已有弹幕碰撞的轨道，碰撞则下沉到最早空闲的一条（允许轻微重叠）。
 *  - 性能：measureText 缓存宽度；同屏数量由 density 上限约束；绘制前先 clear 整屏。
 *
 * 该层不参与任何网络/匹配逻辑（那些在 main 进程的 danmaku.js），
 * 这里只负责"给定一批 {time,mode,color,text}，按媒体时间画出来"。
 */

export class DanmakuRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });

    this.enabled = false;
    this.comments = [];          // 归一化弹幕 [{time,mode,color,text}]，按 time 升序
    this.index = 0;              // 已发射游标（滚动/逆向用，停留型也走此游标）
    this.active = [];            // 当前在屏幕上的弹幕实例
    this.lanes = [];             // 每条轨道的"最晚占用结束时刻"（媒体时间）
    this.laneCount = 0;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    // 显示参数（均可被面板调节）
    this.opacity = 1;            // 0~1
    this.fontSize = 28;          // px@CSS
    this.areaRatio = 1;          // 显示区域占屏高比例 0.25~1
    this.speedScale = 1;         // 滚动速度倍率
    this.density = 200;          // 同屏最大条数
    this._updateFont();

    // 几何（resize 时更新）
    this.cssW = 0; this.cssH = 0;
    this.top = 0; this.bottom = 0;   // 当前画布可用弹幕区（CSS px）

    this._lastNow = 0;
    this._resizeBound = () => this.resize();
    window.addEventListener('resize', this._resizeBound);
    this.resize();
  }

  /**
   * 载入一批弹幕并重置播放状态。
   * @param {Array<{time,mode,color,text}>} comments
   */
  load(comments) {
    this.comments = (comments || [])
      .filter((c) => c && typeof c.text === 'string' && c.text.trim() && c.mode !== 8)
      .map((c) => ({
        time: c.time | 0,
        mode: c.mode | 0,
        color: c.color != null ? c.color | 0 : 0xffffff,
        text: c.text.trim(),
      }))
      .sort((a, b) => a.time - b.time);
    this.active = [];
    this.index = 0;
    this._lastNow = 0;
    this.clearScreen();
  }

  clear() {
    this.comments = [];
    this.active = [];
    this.index = 0;
    this.enabled = false;
    this.clearScreen();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.clearScreen();
  }

  setOpacity(v) { this.opacity = Math.max(0, Math.min(1, v)); }
  setFontSize(px) { this.fontSize = Math.max(12, px | 0); this._updateFont(); this._layoutArea(); }
  setArea(r) { this.areaRatio = Math.max(0.25, Math.min(1, r)); this._layoutArea(); }
  setSpeedScale(s) { this.speedScale = Math.max(0.2, s); }
  setDensity(n) { this.density = Math.max(10, n | 0); }

  _updateFont() {
    this.font = `600 ${this.fontSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.cssW = w; this.cssH = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._layoutArea();
  }

  _layoutArea() {
    // 显示区域：从屏幕顶部往下占多少高度（B 站风格）。
    // 100% = 全屏，75% = 上 3/4，50% = 上半屏，25% = 上 1/4。
    // 之前是垂直居中，导致调小数值时弹幕整体上下移动；现在固定从顶部开始。
    this.top = 0;
    this.bottom = this.cssH * this.areaRatio;
    const laneH = this.fontSize + 8;
    this.laneCount = Math.max(1, Math.floor((this.bottom - this.top) / laneH));
    this.lanes = new Array(this.laneCount).fill(0);
  }

  /**
   * 主渲染调用。now 为当前媒体时间（秒）。
   * 暂停时调用方以相同 now 反复调用（弹幕冻结）；seek 时传入新 now 即可。
   */
  render(now) {
    if (!this.enabled) return;
    const ctx = this.ctx;

    // 时间回退（seek 倒退 / 重载）→ 清屏重排
    if (now < this._lastNow - 0.3) {
      this.active = [];
      this.index = this._findStart(now);
      this.clearScreen();
    }
    // 大步跳跃（拖到很远）→ 仅保留停留型，滚动型重排，避免一次性灌满
    else if (now - this._lastNow > 1.5) {
      this.active = this.active.filter((d) => d.mode === 4 || d.mode === 5);
      this.index = this._findStart(now);
    }
    this._lastNow = now;

    // 发射新弹幕（time<=now 的全部起飞）
    this._emit(now);

    // 推进 + 绘制
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.active.length) return;
    ctx.textBaseline = 'middle';
    ctx.font = this.font;
    ctx.globalAlpha = this.opacity;

    const speedPx = 140 * this.speedScale;   // 像素/秒（基准）
    const live = [];
    for (const d of this.active) {
      if (d.mode === 4 || d.mode === 5) {
        if (now - d.born > 4) continue;       // 停留 4 秒后消失
      } else {
        // 滚动型：位置由媒体时间推算，保证 seek/暂停一致
        const t = now - d.startNow;            // 已飞行秒数
        if (d.reverse) d.x = d.xStart + t * speedPx;
        else d.x = d.xStart - t * speedPx;
        if (d.reverse ? d.x > this.cssW : d.x + d.w < 0) continue;  // 离屏回收
      }
      this._draw(ctx, d);
      live.push(d);
    }
    ctx.globalAlpha = 1;
    this.active = live;
  }

  _draw(ctx, d) {
    const y = this.top + d.lane * (this.fontSize + 8) + this.fontSize / 2 + 4;
    ctx.font = this.font;
    ctx.lineWidth = Math.max(2, this.fontSize / 12);
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.fillStyle = '#' + (d.color & 0xffffff).toString(16).padStart(6, '0');
    ctx.strokeText(d.text, d.x, y);
    ctx.fillText(d.text, d.x, y);
  }

  _emit(now) {
    const list = this.comments;
    while (this.index < list.length && list[this.index].time <= now) {
      const c = list[this.index];
      if (c.mode === 1 || c.mode === 6) this._spawnScroll(c, now);
      else if (c.mode === 4 || c.mode === 5) this._spawnFixed(c, now);
      // 7 退化滚动、其余在前级已过滤
      else this._spawnScroll(c, now);
      this.index++;
    }
  }

  _findStart(now) {
    let lo = 0, hi = this.comments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.comments[mid].time <= now) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _spawnScroll(c, now) {
    if (this.active.length >= this.density) return;
    const ctx = this.ctx;
    ctx.font = this.font;
    const w = ctx.measureText(c.text).width;
    const speedPx = 140 * this.speedScale;
    const travel = this.cssW + w;
    const duration = travel / speedPx;
    const reverse = c.mode === 6;
    const xStart = reverse ? -w : this.cssW;
    const leaveTime = now + duration;

    // 选轨道：第一条"占用结束 <= 当前"的轨道
    let chosen = -1;
    for (let i = 0; i < this.laneCount; i++) {
      if (this.lanes[i] <= now) { chosen = i; break; }
    }
    if (chosen < 0) {
      let best = 0;
      for (let i = 1; i < this.laneCount; i++) if (this.lanes[i] < this.lanes[best]) best = i;
      chosen = best;
    }
    const d = {
      text: c.text, color: c.color, mode: c.mode,
      lane: chosen, w, x: xStart, xStart, reverse,
      startNow: now, born: now,
    };
    this.lanes[chosen] = leaveTime + 0.2;    // 占用到离屏 + 余量
    this.active.push(d);
  }

  _spawnFixed(c, now) {
    if (this.active.length >= this.density) return;
    const ctx = this.ctx;
    ctx.font = this.font;
    const w = ctx.measureText(c.text).width;
    const isTop = c.mode === 5;
    let chosen = -1;
    for (let i = 0; i < this.laneCount; i++) {
      if (this.lanes[i] <= now) { chosen = i; break; }
    }
    if (chosen < 0) {
      let best = 0;
      for (let i = 1; i < this.laneCount; i++) if (this.lanes[i] < this.lanes[best]) best = i;
      chosen = best;
    }
    const x = (this.cssW - w) / 2;
    const yIndex = isTop ? chosen : (this.laneCount - 1 - chosen);
    const d = {
      text: c.text, color: c.color, mode: c.mode,
      lane: yIndex, w, x, born: now,
    };
    this.lanes[chosen] = now + 4.2;          // 停留 4 秒 + 余量
    this.active.push(d);
  }

  clearScreen() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.cssW, this.cssH);
  }
}
