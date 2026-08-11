/**
 * 主时钟。
 *
 * 有音频时以音频为准（声卡晶振驱动，绝对不会漂）；纯视频文件
 * 退化成系统时钟。两种模式对外接口一致，视频渲染循环不需要
 * 知道自己在跟哪个时钟走。
 *
 * 时钟必须单调 —— seek 之外的任何情况下都不允许回退，
 * 否则视频渲染循环会反复重放同一批帧，观感上就是"抖"。
 */

export class MasterClock {
  constructor(audioOutput) {
    this.audio = audioOutput;
    this.source = 'system';

    this.paused = true;
    this.speed = 1.0;

    // 系统时钟模式的状态
    this._sysBase = 0;        // 暂停时冻结的媒体时间
    this._sysAnchor = 0;      // 对应的 performance.now()

    this._last = 0;           // 上次返回值，用于强制单调
    this._audioWasNull = false; // 音频时钟是否刚从"未就绪/断流"恢复
  }

  /** 有音频轨且 worklet 就绪时才切到音频时钟 */
  useAudio(enabled) {
    this.source = enabled ? 'audio' : 'system';
  }

  reset(mediaTime) {
    this._sysBase = mediaTime;
    this._sysAnchor = performance.now();
    this._last = mediaTime;
  }

  play() {
    if (!this.paused) return;
    this.paused = false;
    this._sysAnchor = performance.now();
  }

  pause() {
    if (this.paused) return;
    // 冻结在当前时刻，恢复时从这里继续
    this._sysBase = this.now();
    this.paused = true;
  }

  setSpeed(speed) {
    // 变速前先把已走过的时间结算掉，否则历史时长会被按新倍率重算
    this._sysBase = this.now();
    this._sysAnchor = performance.now();
    this.speed = speed;
  }

  /** 当前媒体时间（秒） */
  now() {
    let t;

    if (this.source === 'audio') {
      const a = this.audio.mediaTime;
      if (a !== null && Number.isFinite(a)) {
        // 音频时钟刚从"未就绪/缓冲断流"恢复（hasBase 由 false 变 true，
        // 或本次时钟值相对上次有明显回退）时，把单调锚点 `_last` 一并重置，
        // 否则下方的单调保护会把正常的"重新对齐"当成抖动吃掉，
        // 把时钟冻结最多 0.5s —— 这正是变速/切轨后偶发音画不同步的元凶。
        const reengaging = this._audioWasNull;
        this._audioWasNull = false;
        t = a;
        // 音频时钟在跑的同时也把系统时钟锚点同步过去，
        // 这样音频中断（切轨、缓冲耗尽）时能无缝接管
        this._sysBase = a;
        this._sysAnchor = performance.now();
        if (reengaging) this._last = a; // 重新对齐，不要被历史 _last 卡住
        // 不再 early-return：让下方统一单调钳制也覆盖音频分支，
        // 过滤 suspend/resume 等造成的时钟源回退（修复 P0#2）。
        // reengaging 已把 _last 重置为 a，下方钳制不会误冻真实对齐。
      } else {
        // 音频还没出声（刚 seek/变速完缓冲未满），暂时用系统时钟顶上
        this._audioWasNull = true;
        t = this.paused ? this._sysBase
          : this._sysBase + (performance.now() - this._sysAnchor) / 1000 * this.speed;
      }
    } else {
      t = this.paused ? this._sysBase
        : this._sysBase + (performance.now() - this._sysAnchor) / 1000 * this.speed;
    }

    // 强制单调：允许 seek 造成的大跳变，但过滤掉时钟源抖动引起的微小回退
    if (t < this._last && this._last - t < 0.5) t = this._last;
    this._last = t;
    return t;
  }

  /** seek 后重新锚定，允许时间倒流 */
  jump(mediaTime) {
    this._sysBase = mediaTime;
    this._sysAnchor = performance.now();
    this._last = mediaTime;
  }
}
