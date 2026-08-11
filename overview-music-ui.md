# 音乐模式 UI 增强（拖拽条 + 窗口按钮 + 自动歌词）

## 完成内容

### 1. 音乐模式可拖拽 + 顶部窗口控制按钮
- **问题**：`body.audio-mode` 下系统标题栏被隐藏，窗口无法拖动；也没有最小化/关闭入口。
- **改动**：
  - `src/renderer/index.html`：在 `#music-stage` 内新增 `.ms-titlebar`（拖拽条）+ `.ms-window-controls`（最小化/关闭按钮）。
  - `src/renderer/style.css`：新增音乐模式顶部条样式；`-webkit-app-region: drag` 用于拖拽，按钮单独设 `no-drag` 保证可点击；按钮默认隐藏、hover 时毛玻璃风格淡入，与 idle 主页右上角控制按钮行为一致。
  - `src/renderer/ui/music-stage.js`：绑定 `m-minimize` / `m-close` 到 `window.lumen.windowCommand('minimize'/'close')`。

### 2. 自动下载同步歌词
- **问题**：歌词只能从同目录 `.lrc` 手动放置，无法自动识别歌曲并显示。
- **改动**：
  - `src/main/ffmpeg/lyrics.js`：新增 `downloadLyrics(mediaPath, meta)`，接入 LRCLIB 免费 API（无需 API Key）。
    - 先按 `track_name + artist_name + album_name + duration` 精确匹配；
    - 未命中则回退 `search?q=` 模糊搜索，按时长差 < 3s 优先选取带 `syncedLyrics` 的结果；
    - 命中后保存 `.lrc` 到音频同目录，下次即可本地读取。
  - `src/main/ipc-media.js`：新增 `app:lyrics-download` IPC；受配置 `music.lyrics-auto-download` 控制。
  - `src/main/preload.js`：暴露 `window.lumen.downloadLyrics(path, meta)`。
  - `src/main/config.js`：新增默认配置 `music.lyrics-auto-download = true`，加入布尔归一与 player.conf 模板。
  - `src/renderer/ui/music-stage.js`：`_loadLyrics(path, info)` 本地未找到时自动调用在线下载；下载成功立即构建歌词视图。

## 验证
- `tools/check-syntax.js`：126 文件 0 失败。
- pre-commit 钩子（语法 / 双向漏网 / 漏导入 / 行尾）全通过。

## 使用说明
- 播放纯音频自动进入音乐模式后，顶部鼠标悬停可拖动窗口、显示最小化/关闭按钮。
- 按 `L` 或点击控制条歌词按钮展开歌词视图；若同目录无 `.lrc` 会自动联网搜索并下载。
- 如需关闭自动下载：在 `player.conf` 中设置 `music.lyrics-auto-download=no`。

## 已知限制
- LRCLIB 曲库为社区维护，部分中文/小众曲目可能缺失；缺失时显示「暂无歌词」。
- 视频模式 mpv 为原生子窗口，四角仍保持矩形（音乐/idle/设置等 UI 模式已圆角）。
