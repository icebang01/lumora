# 把播放器全部功能权限开放给 AI（Lumora）

## 用户需求
> "帮我把播放器的功能权限都对这个 ai 开放"

即让 AI 助手能直接控制播放器的播放行为，而不只是加载字幕/弹幕/改设置。

## 做法：通用命令工具，而非逐个枚举
播放器本身已有一套 **命令总线**（`runCommand` → `player.command`），覆盖 mpv 风格的全部控制能力。本次只需让 AI 接入这条总线，就一次性开放了所有权限：

新增 AI 工具 **`player_command`**：
- 入参：`command`（命令名）+ `args`（参数数组），如 `{command:"seek", args:["30","absolute"]}`
- 执行：经 `ctx.runCommand` → 主进程 `sendToRenderer('player:command')` → 渲染端 `runCommand` → `player.command`

开放的命令（节选）：
| 类别 | 命令示例 |
|------|----------|
| 播放/暂停 | `set pause yes/no`、`cycle pause` |
| 跳转 | `seek 30`、`seek 0 absolute`、`seek 50 absolute-percent`、`frame-step` |
| 音量 | `set volume 80`、`add volume 5`、`cycle mute` |
| 倍速 | `set speed 1.5`、`multiply speed 0.5` |
| 音视频/字幕轨 | `cycle audio`、`cycle sub`、`set aid 1`、`set sid 1` |
| 画面均衡 | `set brightness -10`、`reset-video-eq` |
| 缩放平移 | `set video-zoom 1.2`、`reset-pan-zoom` |
| 全屏/置顶 | `cycle fullscreen`、`cycle ontop` |
| 播放列表 | `playlist-next`、`playlist-prev`、`show-playlist` |
| 截图 | `screenshot` |
| AB 循环 | `ab-loop` |
| 显示文字 | `show-text "..."` |

原有 6 个高层工具（字幕/弹幕/设置/调试/状态/学偏好）保留不动——它们更结构化、更可靠；`player_command` 作为"全部控制"的兜底通道。

## 改动文件
- `src/ai/tools.js`：新增 `player_command` 工具定义 + 执行分支（参数统一字符串化、记 `playerCommands` 统计）。
- `src/main/ai-bridge.js`：`buildCtx` 注入 `runCommand`。
- `src/main/preload.js`：INBOUND 白名单加 `player:command`。
- `src/renderer/app.js`：监听 `player:command` → `runCommand(args)`。
- `src/ai/assistant.js`：系统提示加一句——直接控制类请求用 `player_command`。
- `tools/ai-tests.js`：新增 C9 / C9b，**现 39/39 通过**。

## 验证
- `node --check` 全过（含 app.js 按 ESM 校验）。
- `node tools/ai-tests.js` → 39/39 通过。

## 注意
- `player_command` 是 fire-and-forget（单向下发，不回等待结果）；想确认效果可用 `get_state` 复查。
- 该通道开放了完整命令面，含 `quit` / `loadfile` 等强力命令；按"全部开放"意图保留，真机使用时注意 AI 可能执行退出/换源类命令。
- 沙箱无 GPU/Electron，AI 下发命令→播放器实际响应的端到端联调需真机验证。
