# 修复：播放音乐时音乐舞台上下间距跳动

## 问题
用户截图反馈：播放一首音乐时，音乐舞台（Now-Playing）整体上下的间距会出现几种不同状态，视觉上在「跳动」。

## 根因
1. **credits 块嵌在滚动区顶部 + 负 margin hack**：`.ms-lyrics-credits`（词/曲/编曲/制作人/和声/混音）原本放在滚动容器 `#m-lyrics` 顶部，并用 `margin-top: calc(-1 * var(--lyrics-pad) + 60px)` 把它顶上来。随着歌词滚动、credits 整体滚走、歌词重新居中，整个内容块的有效高度与起始位置不断变化 → 上下间距抖动。
2. **两种居中基准**：`_syncLyrics()` 在 `idx<0`（尚未到第一句）时走 `scrollIntoView({block:'end'})`，到句后走 `block:'center'`，制造出一种独立的间距态。

## 修复（commit `b3e86ce`）
- **HTML**(`index.html`)：把 `#m-lyrics-credits` 从 `#m-lyrics` 内移到 `.ms-meta` 与 `.ms-lyrics-wrap` 之间 —— 彻底独立于滚动歌词区。
- **CSS**(`style.css`)：`.ms-lyrics-credits` 去掉负 margin 与 mask 覆盖，改为 `max-height:240px + overflow:hidden + transition`，新增 `.faded` 折叠态（淡出+收起高度）；`style-cover` 下同步隐藏 credits。
- **JS**(`music-stage.js`)：`_buildLyrics()` 简化（直接 appendChild）；`_updateLyricsCredits()` 显示时移除 `faded`；`_syncLyrics()` 第一句激活后 `creditsEl.classList.toggle('faded', idx>=0)` 淡出折叠，并统一 `scrollIntoView({block:'center'})`（删除 idx<0→block:'end' 分支）。

## 验证
lint:syntax 143/0、lint:imports OK、test:unit 111/111、typecheck 0、pre-commit 4/4 ✓。

## 推送
`github.com:443` 不通，走 Contents API 同步三个文件（远端 `8c8e8a8`/`e6a0ec5`/`11971d9`）。整链对齐需 443 恢复后 `git fetch && git push --force-with-lease origin main`。

## 给用户
彻底杀旧进程（含托盘，单实例锁！）后重启。词曲信息固定出现在信息区下方、不再随歌词滚动跳动；第一句歌词开始后 credits 平滑淡出折叠，歌词始终居中；四种播放器样式下一致（cover 样式隐藏 credits）。
