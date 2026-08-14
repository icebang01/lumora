// 共享限幅工具：将 value 约束在闭区间 [min, max] 内。
// 带 swap 保护：即使 min / max 次序写反，也不会产生错误结果。
export function clamp(value, min, max) {
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  return Math.max(min, Math.min(value, max));
}
