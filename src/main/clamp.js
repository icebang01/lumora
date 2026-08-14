// 共享限幅工具（主进程 CommonJS 版）。
// 与 src/shared/clamp.js（渲染端 ESM 版）逻辑完全一致：将 value 约束在闭区间 [min, max]，
// 含 swap 保护（min > max 时交换），lo/hi 次序写反也不会产生错误结果。
function clamp(value, min, max) {
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  return Math.max(min, Math.min(value, max));
}

module.exports = { clamp };
