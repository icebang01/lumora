/**
 * 渲染端内部调优常量（非用户配置，集中于此避免散布魔法数字）。
 *
 * 与 src/main/config.js 的 DEFAULTS 分工：
 *   - config.DEFAULTS 里的是"用户可调 + 跨进程下发"的项（如 flow-high-seconds）。
 *   - 本文件的 RENDER_DEFAULTS 是纯渲染端内部节拍/容量旋钮，不进 player.conf，
 *     用户无需关心，但代码里不该再出现裸数字。
 *
 * 若日后这些旋钮需要暴露给用户，直接挪到 config.DEFAULTS 即可，调用方不变。
 */

export const RENDER_DEFAULTS = {
  /** 默认视频帧队列容量（无配置时的兜底，init 时会被 frame-queue-size 覆盖） */
  defaultQueueSize: 12,

  /** FPS 采样环形缓冲上限：约 120 样本 ≈ 4~5 秒窗口，足够平滑又不无限增长 */
  frameTimesMax: 120,

  /** 续播位置上报主进程的最小间隔（ms）：太久不存、太频繁浪费 IPC */
  reportIntervalMs: 2000,

  /** 时钟未初始化时的兜底帧率（HDR/未知源的常见默认） */
  defaultFps: 25,

  /**
   * 音频初始化缓冲帧数计算（保持与原硬编码一致的行为，仅去掉裸数字）：
   *   frames = audio-buffer(秒) * audioFramesPerSecond，但若 audio-buffer 为 0
   *   则回退到 audioBufferZeroFallback；最终结果不小于 audioBufferMinMultiplier。
   * 原公式 Math.max(2, cfg['audio-buffer'] * 12 || 4)。
   */
  audioBufferMinMultiplier: 2,
  audioFramesPerSecond: 12,
  audioBufferZeroFallback: 4,
};

export default RENDER_DEFAULTS;
