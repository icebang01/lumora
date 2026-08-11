# 修复：音乐舞台信息 / credits / 歌词垂直布局失衡

## 问题
用户在 Task #200 修复后反馈「越来越严重了」，截图显示：
- credits 块把歌词区大幅压到底部，上半截大面积留白；
- credits 折叠后，整体内容仍偏下。

## 根因
- `.ms-right` 固定 560px 高度且默认 `justify-content: flex-start`，信息、credits、歌词区全部堆在顶部；
- `.ms-lyrics-wrap` 设 `flex: 1` 占满剩余空间，导致歌词区被压得很低，credits 与歌词之间出现巨大真空；
- credits 字号/内边距偏大，进一步压缩歌词区。

## 修复（commit `497172b`）
- `src/renderer/style.css`：
  - `.ms-right` 增加 `justify-content: center`，让信息+credits+歌词整体垂直居中；gap 从 18px 收紧到 14px。
  - `.ms-lyrics-wrap` 改为 `flex: 1 1 auto; min-height: 200px; max-height: 320px`，限制歌词区最大高度。
  - `.ms-lyrics-credits` 减小 `padding-bottom` 与 `gap`。
  - `.ms-credit-row` 字号从 `clamp(17px, 2.3vw, 23px)` 降到 `clamp(14px, 1.9vw, 18px)`。

## 验证
lint:syntax 143/0、lint:imports OK、test:unit 111/111、typecheck 0、pre-commit 4/4 ✓。

## 推送
- commit `497172b`：`fix(music): center right-column content and cap lyrics height`
- `github.com:443` 不通，走 Contents API 推送 `style.css`（远端 `0738fa2`）。整链对齐需 443 恢复后 `git fetch && git push --force-with-lease origin main`。

## 给用户
彻底杀旧进程（含托盘，单实例锁！）后重启。现在信息、credits、歌词会作为整体在音乐舞台右栏居中分布，不再全部堆在顶部；歌词区最大高度受限，credits 字号和间距也收小了，整体会更紧凑。如仍不满意可继续截图反馈。
