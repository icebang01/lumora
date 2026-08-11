# 播放列表循环模式（四态）实现概览

## 做了什么
为 Lumen 播放器实现了完整的**四态循环模式**，补齐了 P1 待办中的「循环模式」项。

四态切换：`off（关闭）→ list（列表循环）→ file（单曲循环）→ random（随机播放）→ off`

切换方式：点击 OSC 控制条上的循环按钮，或按 `L` 键。

## 关键设计
- **Lumen 自管播放列表**（`playlist` 数组 + `playlistJump`），并非 mpv 内部 playlist，因此 mpv 的 `loop`（列表循环）对我们无效——这是本功能的核心约束。
- **单曲循环（file）**交给 mpv 原生处理：`loop-file=inf` 时 mpv 自动重播当前文件，不触发 `eof`。
- **列表循环 / 随机循环**由 Lumen 状态机驱动：
  - `list`：播完自动跳下一首，到列表尾回第一首
  - `random`：每次跳到与当前不同的随机位置（`do-while` 排除当前）
  - `off`：播到列表尾后回到 idle 落地页

## 改动文件
| 文件 | 改动 |
|------|------|
| `src/renderer/app.js` | `loopMode` 状态机、`setLoopMode`/`cycleLoopMode`、`playlistJump` 随机选位、`eof` 按模式分流、抽 `endOfPlaylist`、命令路由 `loop-mode-cycle`/`loop-mode-set`、暴露测试钩子 |
| `src/renderer/ui/osc.js` | `btn-loop` 点击接状态机；`paintLoop` 改事件驱动（`lumen:loopmode`）四态图标 |
| `src/renderer/index.html` | `btn-loop` 去掉无效的 `data-cmd`；新增 `icon-loop-random` SVG |
| `src/shared/default-keybinds.js` | L 键从无效的 `cycle-values loop-file inf no` 改为 `loop-mode-cycle` |
| `src/main/index.js` | 新增 `--test-loopmode` 自动化测试（`runLoopModeTest`） |

## 验证
- `node --check` 全部通过（index.js / mpv-backend.js / app.js / osc.js）
- `--test-loopmode` **PASS**：四态顺序正确、random 模式 20 次跳转全部换位置
- 正常启动无 JS 报错（mpv 四模式失败属沙箱无 GPU 预期）

## 用户使用
1. 打开多个文件或文件夹建立播放列表
2. 点 OSC 循环按钮或按 `L`，在 关闭 / 列表 / 单曲 / 随机 间切换
3. 按钮图标实时反映当前模式（⥁ 关闭 / 单曲 / 列表 / 🔀 随机）

## 下一步
- **P0 真机验证**：沙箱无 GPU，需在真机确认 mpv 实际的单曲/列表循环行为
- 播放列表增强其余项：拖拽排序、缩略图、添加/替换 UX 选择
