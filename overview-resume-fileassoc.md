# 文件关联 + 继续观看 UI（商用化 P0）

> 承接此前商用化主线，本次补齐两项 P0 能力，并全部通过自动化回归。

## 1. 文件关联（双击用 Lumen 打开）

**改了什么**
- **命令行/双击打开链路已贯通**：`bootstrap` 用 `parseArgv(userArgs(argv))` 取文件路径 → `pendingOpenFile` → 渲染端启动即载入；已运行时再次双击走 `second-instance`，macOS 走 `open-file`。
- **新增 `app:open-file` IPC**：主进程向渲染端广播外部打开的文件，渲染端监听后退出 idle 并载入（无文件时）。
- **「关联到系统文件类型」开关**（设置 → 常规）：切换时在主进程写/清 `HKCU\Software\Classes` 下的 `.ext → Lumen.MediaFile` 及 `shell\open\command`。**当前用户级，无需管理员**。
- **`package.json` 新增 `build.fileAssociations`**：23 个媒体扩展名，供 electron-builder 打包时做系统级关联。

**怎么用**
- 设置里打开「关联到系统文件类型」→ 双击任意 mp4/mkv 等即用 Lumen 打开。
- 或直接打包安装（electron-builder 已配置关联），安装时即注册。

## 2. 继续观看 UI

**改了什么**
- 新增 `src/main/resume-store.js`：把最近一个媒体的 `{path, time, duration, title}` 存到 `userData/resume.json`。
- **保存时机**：退出时（`before-quit`）+ 播放中每 5 秒定时保存（崩溃也不丢进度）。
- **idle 屏出现「继续观看」卡片**：进入 idle 时自动拉取续播点并展示标题与「上次看到 mm:ss」；点击即从该位置继续（主进程 `loadFile` 会按 watch_later 自动 seek）。
- 自然播放到结尾时清除卡片，下次启动不再提示这部。
- 卡片样式遵循 `DESIGN.md`：毛玻璃 + 青紫粉渐变。

## 3. 验证结果

| 测试 | 结果 |
|---|---|
| `--test-file-assoc` | PASS（argv 提取 + IPC 链路） |
| `--test-resume` | PASS（卡片出现、含「12:30」、点击记录路径） |
| `--test-open-settings` | PASS |
| `--test-dialog-cancel` | PASS |
| `--test-settings-dblclick` | PASS |
| `--test-settings-apply` | PASS |
| `--test-keymap` | PASS |

## 4. 备注
- 沙箱无 GPU，mpv 视频后端无法启动（预期），但 UI 与全部逻辑正常加载、测试通过。
- HKCU 注册表写入在沙箱无法真实落盘验证，函数已 `try/catch` 容错；请在真机点一次开关确认生效。
