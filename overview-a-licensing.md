# A：去 GPL — FFmpeg 切 LGPL + 许可清理

## 背景（关键架构事实）
活跃视频后端是 **mpv**（GPLv2+），渲染端 `createEngine()` 只实例化 `MpvPlayer` 或 `MediaFoundationEngine` 占位。
主进程的 `MediaPipeline`（FFmpeg→WebSocket）存在，但**渲染端没有对应的 WebGL2 引擎类**，直接 `engine=ffmpeg` 会让画面无法渲染。
→ **mpv 当前不可移除**，删 `mpv.exe` 会破坏播放。彻底去 mpv 必须实现路线 A 的 Media Foundation 后端（C++ N-API addon，阶段 2/3）。

## 本期已做的（安全可达部分）
把 **ffmpeg/ffprobe 从 GPL 构建切到 LGPL 构建**，mpv 作为仅剩的 GPL 聚合组件（义务已文档化）。

| 文件 | 改动 |
|------|------|
| `tools/fetch-ffmpeg.js`（新） | 从 BtbN `win64-lgpl` 构建拉取 ffmpeg/ffprobe 到 `bin/`，覆盖 GPL 构建并校验 |
| `src/main/ffmpeg/binaries.js` | 启动检测 GPL 标记并告警；LGPL 时确认 |
| `package.json` | `build.productName` / 25 处 `fileAssociations` 名 Lumen→Lumora；`keywords` 去 `mpv`；加 `fetch-deps` 脚本 |
| `.gitignore`（新） | 忽略 GPL 的 `bin/ffmpeg.exe`/`bin/ffprobe.exe`（发布前 fetch-deps 拉取） |
| `THIRD_PARTY_LICENSES.md` | ffmpeg 改 LGPL 现状；合规清单标记 ffmpeg-lgpl=done、mpv 移除=路线 A 待办 |
| `src/renderer/app.js` | 应用内「开源声明」FFmpeg 文案同步为 LGPL v2.1 |
| `MEDIAFOUNDATION_ENGINE.md` | 顶部加「当前进展」：ffmpeg 已 LGPL、mpv 唯一可用后端、去 mpv 需阶段 2/3 |

## 验证
- `node --check` 通过（binaries.js / fetch-ffmpeg.js）
- `package.json` 合法 JSON；无 Lumen 残留、keywords 无 mpv

## 待决策（下一步）
唯一仍含 GPL 二进制的组件是 **mpv**。彻底去除 = 实现路线 A 的 Media Foundation 后端
（C++ N-API addon + `MediaFoundationEngine` 接入，阶段 2/3），完成后删 `bin/mpv.exe` +
`mpv-backend.js`，LICENSE 可恢复商业闭源。是否投入该重写请确认。
