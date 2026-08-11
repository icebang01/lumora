# 优化：T 恤图标上下压扁 8%

## 需求
用户截图反馈播放器样式 T 恤图标需要「上下压扁一点」。

## 改动
- `src/renderer/style.css`：`#m-btn-style svg` 增加 `transform: scaleY(0.92); transform-origin: center;`，让图标在垂直方向整体压缩约 8%。
- 空心描边默认态与实心填充悬停态同步生效，无需改动 SVG 路径。

## 验证
lint:syntax 143/0、lint:imports OK、test:unit 111/111、typecheck 0、pre-commit 4/4 ✓。

## 提交与推送
- commit `4ce246a`：`style(music): squash T-shirt icon vertically by 8%`
- `github.com:443` 不通，走 Contents API 推送 `style.css`（远端 `d446be9`）。整链对齐需 443 恢复后 `git fetch && git push --force-with-lease origin main`。

## 给用户
彻底杀旧进程（含托盘，单实例锁！）后重启。T 恤图标现在会比之前扁一些。如仍不够扁或比例仍不对，可继续截图反馈。
