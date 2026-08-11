# 优化：播放器样式 T 恤图标替换为参考图形状

## 需求
用户发送参考 PNG `258皮肤&主题.png`（白色圆领短袖圆下摆 T 恤剪影），要求直接替换音乐控制台右侧「播放器样式」的 T 恤图标。

## 改动
- `src/renderer/index.html`：`#m-btn-style` 的 SVG 路径改为匹配参考图轮廓：圆领（Q 曲线）、短袖外伸、侧腰微收、圆下摆。
- 保留之前的双态交互：默认空心描边，hover / 菜单展开时实心填充。

## 验证
lint:syntax 143/0、lint:imports OK、test:unit 111/111、typecheck 0、pre-commit 4/4 ✓。

## 提交与推送
- commit `d0e4a23`：`style(music): replace player-style T-shirt icon with reference shape`
- `github.com:443` 不通，走 Contents API 推送 `index.html`（远端 `b5a673e`）。整链对齐需 443 恢复后 `git fetch && git push --force-with-lease origin main`。

## 给用户
彻底杀旧进程（含托盘，单实例锁！）后重启。控制条右侧的 T 恤图标现在是参考图的圆领短袖圆下摆形状；默认空心，hover/展开菜单时实心。
