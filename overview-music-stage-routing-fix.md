# 音乐舞台「黑屏/不显示」根因与修复

## 症状
黑胶（vinyl）模式下音乐舞台整片不显示 / 闪一下后黑屏，反复重启无效。

## 根因
渲染端舞台路由与主进程解码后端选择**判定标准不一致**：

- 主进程（`src/main/play-control.js:61-64`）：`source:'music'` 会**强制**走 ffmpeg 纯音频后端
  （双引擎切换语义：「音乐模式不启动 mpv」），与 ffprobe 算出的 `info.audioOnly` 解耦。
- 渲染端（`src/renderer/app-events.js`）：此前用 `payload.info.audioOnly` 决定是否 `enterAudioMode`。

当两者 disagree（例如 source 被强制为 music，而 ffprobe 误报 `audioOnly=false`）时：
音乐引擎正常播放音频，但渲染端走 `else exitAudioMode()` → `#music-stage` 被加回 `hidden`
且 `body.audio-mode` 不挂 → 舞台 `opacity:0 / display:none` → **音乐在播却无舞台、黑屏不显示**。

## 修复（commit 678096f，已推 origin/main）
1. **渲染端路由以 `payload.source` 为准**：`isMusic = payload.source === 'music' || info.audioOnly`，
   与主进程后端选择保持一致；`audioOnly` 仅作兜底。
2. **隔离 `eng.onLoaded` 异常**：包 `try/catch`，任何引擎层意外报错都不会再阻断 `enterAudioMode/exitAudioMode`。
3. **可疑竞态可观测**：`exitAudioMode` 在确实隐藏一个已激活舞台时打印调用栈，便于下次运行精准定位
   是否仍有 `idle-enter` 之外的意外隐藏。

## 已排除的疑点（静态核查）
- `style-vinyl` 正确挂在 `#music-stage`（非 body），CSS 选择器匹配无误。
- `index.html` 含全部唱机 DOM（`.ms-turntable-base/.ms-platter/.ms-vinyl/.ms-cover/.ms-spindle/.ms-tonearm`）。
- `Player.onLoaded` 已在 `src/renderer/core/player.js:680` 重写，非抛错桩。
- 音乐路径仅 `play-control.js:137` 派发 `player:loaded`；`media-pipeline.js:82` 的 hwaccel-fallback
  仅视频，不存在重复派发导致的「进入即退出」闪屏。

## 门禁
lint:syntax 145/145 · lint:imports OK · typecheck OK · test:unit 111/111 · 已提交并推送。

## 若拉取后仍不显示
查看终端 `[lumen][stage]` 日志：
- `source='music' isMusic=true hidden=false` → 已进入，问题在 GPU/透明窗口合成（环境）。
- `source='video'`（文件被当视频）→ 检查该文件是否含视频轨 / 是否从视频入口载入。
- `exitAudioMode 隐藏音乐舞台，调用栈: …idle-enter…` → 仍有竞态，按栈修对应 `setIdleMode(true)` 调用点。
