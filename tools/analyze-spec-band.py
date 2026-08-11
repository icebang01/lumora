from PIL import Image
import numpy as np
img = Image.open(r"D:\IDEA\videos\_design_archive\spectrum-visual.png").convert("RGB")
a = np.asarray(img, dtype=np.float32)
h, w = a.shape[:2]
dpr = 1.5
# wrapper: 逻辑 700x150 @ y=713, x=524 → 物理 1050x225 @ y=1069.5, x=786
x0, y0 = int(524 * dpr), int(713 * dpr)
reg = a[y0:y0 + 225, x0:x0 + 1050]
lum = reg.mean(axis=2)
# 频谱柱是纯蓝（B 显著高），背景是暗蓝绿渐变——用蓝色判别掩码
blue = (reg[:, :, 2] - reg[:, :, 0] > 40) & (reg[:, :, 2] > 130)
mask = blue
# 柱高分布：每列（x 方向）找最高亮行（从底部往上），柱高 = 225 - top
heights = []
for x in range(0, 1050, 8):
    colmask = mask[:, x]
    if colmask.sum() > 3:
        top = np.where(colmask)[0].min()
        heights.append(225 - top)
if len(heights) < 20:
    print("亮柱太少:", len(heights)); raise SystemExit
hs = np.array(heights)
n = len(hs)
left, mid, right = hs[:n//3].mean(), hs[n//3:2*n//3].mean(), hs[2*n//3:].mean()
print(f"柱高(px): 左={left:.0f} 中={mid:.0f} 右={right:.0f} (n={n})")
print(f"中间最高: {'YES ✓' if mid > left and mid > right else 'NO ✗'}")
# 平滑度：相邻柱高差均值（越小越平滑）
diffs = np.abs(np.diff(hs))
print(f"相邻柱高差均值: {diffs.mean():.1f}px (越小越柔和)")
print(f"柱高范围: {hs.min():.0f}-{hs.max():.0f}px")
# 渐变检查：中间最高柱的垂直颜色（底部→顶部）
cx = n // 2 * 8
col = reg[:, cx]
colmask = mask[:, cx]
if colmask.sum() > 3:
    ys = np.where(colmask)[0]
    bottom = col[ys[-1]-3:ys[-1]+1].mean(axis=0)
    top = col[ys[0]:ys[0]+3].mean(axis=0)
    print(f"渐变: 柱底 RGB=({bottom[0]:.0f},{bottom[1]:.0f},{bottom[2]:.0f}) 柱顶 RGB=({top[0]:.0f},{top[1]:.0f},{top[2]:.0f})")
