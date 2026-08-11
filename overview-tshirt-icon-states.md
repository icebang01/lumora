# 优化：播放器样式 T 恤图标（空心/实心双态）

## 用户需求
用户发来两张 T 恤图标参考（空心白 + 实心白），要求把音乐控制台右侧的「播放器样式」图标照着参考做。

## 实现
将 `#m-btn-style` 的 T 恤图标改为 SVG 双路径状态：
- **默认态**：空心描边（`stroke="currentColor"`，线宽 1.6，圆角连接）。
- **悬停态 / 菜单展开态**：实心填充（`fill="currentColor"`）。

## 改动文件
- `src/renderer/index.html`：`#m-btn-style` 的 SVG 增加 `.m-style-outline` 与 `.m-style-fill` 两条路径。
- `src/renderer/style.css`：新增状态过渡样式；默认显示 outline，hover 或 `aria-expanded="true"` 时切换为 fill，过渡 180ms。

## 验证
lint:syntax 143/0、lint:imports OK、test:unit 111/111、typecheck 0、pre-commit 4/4 ✓。

## 提交与推送
- commit `602b9f3`：`style(music): add T-shirt player-style icon with outline/fill states`
- `github.com:443` 不通，走 Contents API 推送 `index.html`（`3c583b8`）与 `style.css`（`b95fc07`）。整链对齐需 443 恢复后 `git fetch && git push --force-with-lease origin main`。

## 给用户
彻底杀旧进程（含托盘，单实例锁！）后重启。音乐模式下底部控制条右侧的 T 恤图标默认是空心描边，鼠标放上去或点击展开样式菜单时变为实心填充。如果希望默认就是实心，可以告诉我。
