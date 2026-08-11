/**
 * 视频帧队列 + 呈现策略。
 *
 * 这是音画同步的执行端。核心问题只有一个：在时刻 t，该显示哪一帧？
 *
 * 策略（与 mpv 的 video-sync=audio 一致）：
 *   - 队首帧 PTS 比时钟早太多（迟到）→ 丢弃，追赶
 *   - 队首帧 PTS 落在当前显示窗口内 → 呈现
 *   - 队首帧 PTS 还在未来 → 保持当前画面，等下一次 vsync
 *
 * "显示窗口"取半帧时长：这样每帧的呈现时机误差不超过 ±半帧，
 * 而不会因为显示器刷新率与视频帧率不整除而周期性抖动。
 */

export class FrameQueue {
  constructor(maxSize = 12) {
    this.frames = [];
    this.maxSize = maxSize;
    this.epoch = 0;

    // 统计
    this.dropped = 0;
    this.presented = 0;
    this.late = 0;
    this.totalReceived = 0;
  }

  setEpoch(epoch) {
    this.epoch = epoch;
    this.frames.length = 0;
  }

  /**
   * @param {{data: Uint8Array, pts: number, epoch: number, width: number, height: number}} frame
   */
  push(frame) {
    if (frame.epoch !== this.epoch) return false; // seek 后的陈旧帧
    this.totalReceived++;

    // 队列满：丢最老的未显示帧。这比丢新帧好 —— 新帧更接近当前时钟
    if (this.frames.length >= this.maxSize) {
      this.frames.shift();
      this.dropped++;
    }
    this.frames.push(frame);
    return true;
  }

  /**
   * 取出应在时刻 t 显示的帧。
   * @param {number} t 当前媒体时间
   * @param {number} frameDuration 一帧时长（秒）
   * @returns {object|null} 需要上屏的帧，null 表示维持当前画面
   */
  take(t, frameDuration) {
    if (this.frames.length === 0) return null;

    const window = frameDuration * 0.5;
    // 迟到容忍：根据队列余量动态调整。
    // - 队列充足（>= 半满）时严格追时钟，只保留 2 帧窗口，避免越落越远。
    // - 队列低位（<= 2）时解码器可能跟不上，放宽到 8 帧，优先保证“看得见”。
    // - 正常情况取 4 帧，在同步精度与抗抖动之间平衡。
    let lateThreshold = frameDuration * 4;
    if (this.frames.length >= this.maxSize * 0.5) lateThreshold = frameDuration * 2;
    else if (this.frames.length <= 2) lateThreshold = frameDuration * 8;

    // 先丢弃严重迟到的旧帧，但永远保留队列里至少一帧。
    // 如果全丢光了，后面就没有帧可呈现，画面会黑掉——这就是用户看到的 bug。
    while (this.frames.length > 1 && this.frames[0].pts < t - lateThreshold) {
      this.frames.shift();
      this.dropped++;
      this.late++;
    }

    const f = this.frames[0];

    // 队首帧还在未来：继续等，保持当前画面
    if (f.pts > t + window) return null;

    // 到点了 / 略慢但总比黑屏强：取出队首帧上屏
    const chosen = this.frames.shift();

    // 同一 vsync 窗口内可能该过好几帧，统一弹出避免重复渲染
    if (chosen.pts <= t + window) {
      while (this.frames.length > 0 && this.frames[0].pts <= t + window) {
        this.frames.shift();
        this.dropped++;
      }
    }

    this.presented++;
    return chosen;
  }

  /** 队列里缓冲了多少秒的画面 */
  bufferedSeconds(frameDuration) {
    if (this.frames.length < 2) return this.frames.length * frameDuration;
    return this.frames[this.frames.length - 1].pts - this.frames[0].pts + frameDuration;
  }

  get length() { return this.frames.length; }
  get first() { return this.frames[0] || null; }

  clear() { this.frames.length = 0; }

  resetStats() {
    this.dropped = 0; this.presented = 0; this.late = 0; this.totalReceived = 0;
  }
}
