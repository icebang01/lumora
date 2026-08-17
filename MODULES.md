# Lumora 代码结构地图（2026-08 整理）

> 目标：每个功能改哪里、去哪里找，一眼定位。
> 整理原则：按"领域"归文件，模块间用 **ctx 注入**（`setCtx({...})`）传递共享状态，调用处保持同名函数解构导入。

## 一、主进程 `src/main/`

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `index.js` | ~587 | **入口/启动**：bootstrap（ctx 装配）、sendToRenderer、smoke/TEST 流程调度、teardown | `bootstrap` |
| `register-ipc.js` | 21 | **IPC 编排器**（2026-08 拆出）：`setCtx` 注入宿主状态 → `registerIpc()` 分发给 player/media/window/app/cast/updater 域 | `setCtx` `registerIpc` |
| `ipc-player.js` | 231 | **IPC·播放域**：player:\*（载入/seek/速度/轨道/hwdec/停止/截图/落盘）+ mpv:\* 直通 | `register(ctx)` |
| `ipc-media.js` | 204 | **IPC·内容域**：subtitles:\* + danmaku:\* + app:\*（续播/历史/缩略图/封面/歌词）+ playlist:\* | `register(ctx)` |
| `ipc-window.js` | 139 | **IPC·窗口域**：ui:set-idle-state + window:command + pip:\*（拖动/缩放/按钮，pipDragBase 属此域） | `register(ctx)` |
| `ipc-app.js` | 179 | **IPC·配置域**：app:bootstrap + config:\*（含键位编辑）+ scripts:list | `register(ctx)` |
| `ipc-updater.js` | — | **IPC·更新域**：updater:get-state / updater:check / updater:install | `register(ctx)` |
| `updater.js` | — | **自动更新**（electron-updater，GitHub Releases）：dev 模式禁用；启动静默检查；发现→autoDownload；downloaded 后等用户确认安装；事件 updater:status / updater:progress | `setCtx` `setup` `checkForUpdates` `installUpdate` `getState` |
| `windows.js` | 463 | **双窗口管理**（2026-08 拆出）：computeWindowSize/createWindow/syncWindows/resyncNow/setFullscreen/ensureVideoWindow/attachRendererDiagnostics + 窗口同步事件链；ctx 注入 **win/videoWin getter/setter**（单一事实源留在 index.js，sendToRenderer/startMpv 也走 ctx） | `setCtx` `createWindow` `resyncNow` `setFullscreen` `ensureVideoWindow` |
| `media-pipeline.js` | 75 | **ffmpeg 引擎解码编排**（2026-08 拆出）：setupPipeline（MediaPipeline 事件接线 + 背压）；ctx 注入 **pipeline getter/setter**（单一事实源留在 index.js）+ getConfig/getMediaServer/getCurrentInfo/getLastKnownTime/sendToRenderer | `setCtx` `setupPipeline` |
| `mpv-launch.js` | 132 | **MPV 后端启动**（2026-08 拆出）：resolveMpvPath/createMpvBackend/startMpv；ctx 注入 **mpvBackend getter/setter**（单一事实源留在 index.js）+ getConfig/sendToRenderer；createMpvBackend 必须在窗口创建前调用（渲染端 boot() 可能先于 startMpv 触发 loadFile） | `setCtx` `resolveMpvPath` `createMpvBackend` `startMpv` |
| `play-control.js` | 195 | **播放控制**：loadFile（ffprobe 探测/续播/引擎分支/loaded 下发）、applyAspectRatio、currentDar | `setCtx` `loadFile` `applyAspectRatio` |
| `pip.js` | 183 | **画中画**：togglePip/控制浮窗/退出还原 + sanitizeInfo | `setCtx` `togglePip` `getPipMode` `sanitizeInfo` |
| `smoke-test.js` | 861 | **冒烟测试**（--smoke-test 全量断言 + 全部 --test-* 专项：dialog-cancel/settings/keymap/file-assoc/resume/playlist/loopmode，**9 个 run\*Test 必须全部 export**——曾漏导出导致 --test-* 流程 ReferenceError） | `runSmokeTest` 等 10 个 |
| `media-auto.js` | 133 | **字幕/弹幕自动加载** | `setCtx` `extractAndSendSubtitles` 等 |
| `file-assoc.js` | 96 | **文件关联** + 播放列表文件收集 | `applyFileAssociation` 等 |
| `resume.js` | 70 | **续播位置** | `setCtx` `readWatchLater` 等 |
| `mpv-backend.js` | — | mpv 子进程 JSON IPC 封装 | `MpvBackend` |
| `media-server.js` | — | ffmpeg 引擎媒体服务 | `MediaServer` |
| `preload.js` | — | contextBridge：`window.lumen`（**没有 run 方法**） | — |
| `resume-store.js` | — | 继续观看卡片数据存储 | `saveResume` 等 |
| `config.js` | — | 配置读取/解析/写入 | `Config` `parseArgv` |
| `media-apply.js` | — | 字幕/弹幕/AI 应用层 | `autoLoadSubtitle` 等 |
| `ffmpeg/` | — | ffmpeg 管线 + probe | `resolveBinary` `probeMedia` |
| `ai/` | — | AI 助手桥接 | `AiBridge` |

### ctx 注入约定（新增模块模式）
```js
// 模块内
let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
// 动态值必须传 getter：
//   getConfig: () => config        ← 启动后才赋值的顶层变量
//   getCurrentInfo: () => currentInfo
module.exports = { setCtx, ... };

// index.js bootstrap 开头统一注入
resume.setCtx({ getConfig: () => config, getCurrentInfo: () => currentInfo, ... });
```

## 二、渲染端 `src/renderer/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `app.js` | ~606 | **渲染端主控**：boot、runCommand 命令分发、播放列表/循环状态机、加载遮罩/继续观看调度、toggleKeymap |
| `app-diagnostics.js` | 179 | **渲染端诊断**（2026-08 拆出）：exposeDiagnostics（window.__lumen 快照/探针）+ setupDebug（调试 HUD）；`setupDiagnostics(ctx)` 注入（**注意：keybinds/scripts/osd 必须传 getter**，值引用会因时机/替换失效） |
| `app-events.js` | 144 | **主进程事件绑定**（2026-08 拆出）：bindMainEvents（window.lumen.on 全部分发 + 音频不可用提示）；`setupMainEvents(ctx)` 注入；**playlist 走 getter 代理**（setPlaylist 会整体替换数组引用，不能存旧引用） |
| `input.js` | 283 | **输入绑定**（2026-08 拆出）：bindInput/bindDragDrop/bindAudioUnlock/bindClickToFront + isEditable/isUiTarget/isNonRepeatable；`setupInput(ctx)` 注入；命令执行走 context-menu.js 导出的 `execute`（此前漏 export 的 bug 一并修复） |
| `panels/` | — | **已拆出的面板模块**：`licenses.js`（开源声明）、`context-menu.js`（右键菜单 + **execute 命令执行**）、`subtitles.js`（在线字幕搜索）、`danmaku.js`（弹幕搜索/匹配）、`settings.js`（设置面板，最大块 877 行）、`idle.js`（idle 屏/遮罩/继续观看卡片/最近播放）、`playlist.js`（播放列表面板）——自包含模块 + ctx 注入（app.js boot 时 `setupXxx(ctx)` 传入 player/runCommand/osd/closeOthers/getBootstrapData/getKeymap 等；模块内 `let visible` + `isXxxVisible()` 导出；player/keybinds 用 Proxy 全转发；**跨面板互斥直接 import 对方面板模块**，面板间无循环）。**feedback.js 已拆入 player/（2026-08-07）** |
| `player/` | — | **两个独立播放器模块（2026-08-07 拆出，视频/音乐彻底分离）**：`video-player.js`（375 行）——视频引擎创建（mpv/ffmpeg/MF 分支）+ 视频反馈（字幕/音量/渲染参数/EOF/载入）+ 质量徽章 + 加载遮罩 + `load/stop/applyStage`；`music-player.js`（234 行）——音乐引擎（mpv 纯音频）+ 音频舞台（封面/唱片/歌词）+ 音乐反馈 + `load/stop/applyStage/refreshStage`。统一接口 `createXxxPlayer(bootstrapData, ctx)`；共享 UI（OSC/统计/脚本）经 app.js 的 `player` 代理（`activeEngine()`）指向活跃模块；进入 idle 由 idle.js 发 `lumen:idle-enter` 事件，各播放器自行清理（避免 idle↔player 循环依赖） |
| `index.html` | — | 页面结构（OSC/OSD/idle 屏/各面板 DOM） |
| `style.css` | — | 全部样式（注意 `body.idle-mode.cursor-hidden` 修正过） |
| `core/` | — | **播放引擎**：`engine.js`(基类/属性观察)、`player.js`(ffmpeg)、`mpv-player.js`(mpv)、`audio.js`+`audio-worklet.js`(WebAudio)、`transport.js`(WebSocket) |
| `ui/` | — | **UI 组件**：`osc.js`(控制条)、`osd.js`(屏幕提示/静默窗口)、`stats.js`(统计面板)、`ai-panel.js`、`keymap.js`+`keys.js`+`keybind-editor.js` |

## 三、测试工具 `tools/`

| 文件 | 用途 |
|---|---|
| `run-smoke.js` | 冒烟测试启动器（无头跑 `--smoke-test`，串行；**自动加独立 `--user-data-dir`**——用户开着播放器时共享 profile 会被锁导致假失败，见 2026-08 排障与 ADR-0003） |
| `run-gui-test.js` | **GUI 自动化启动器**（2026-08）：拉起隔离 CDP 实例（`--remote-debugging-port=9222` + 独立 userData）→ 跑 gui-test.js → 清理 |
| `check-syntax.js` | **语法门禁**（2026-08）：全仓 node --check（renderer ESM 自动降级 .mjs），CI 第一步 |
| `selftest.js` | 无头管线自检（ffmpeg 引擎 WebSocket 全链路） |
| `gui-test.js` | **GUI 自动化**（CDP 驱动，13 项断言；播放器需 `--force-renderer-accessibility --remote-debugging-port=9222` 启动；媒体路径强制绝对路径；用 `run-gui-test.js` 一键跑） |
| `window-sync-tests.js` | 窗口对齐单元测试（6 项，独立工具；node:test 版见 `test/unit/window-sync.test.js`） |
| `scan-reverse-leaks.js` | **反向漏网扫描**（2026-08）：抓"调用其他模块内未导出函数"类 bug（execute 漏 export 就是这类）；迷你词法器过滤注释/字符串，只报自由调用 |
| `test/unit/` | **单元测试**（2026-08，node:test 零依赖，31 项）：window-sync 几何（7）/filename-parser（9）/protocol（6）/config 解析（4）/subtitles 电影哈希（4，mock electron）/**pixfmt 双表漂移检测（2，wire.js 复制为 .mjs 动态导入对比 protocol.js）**。`npm run test:unit` 运行 |
| `opt-tests.js` | **优化专项测试**（WorkBuddy 2026-08-05 引入，68 项）：音频采样率回填/decoder throttle/media-server 缓冲池等纯函数+mock。已接入 `npm test`（`test:opt`） |

## 四、常见修改入口速查

| 想改什么 | 去哪个文件 |
|---|---|
| 播放/暂停/停止行为（图标、重播） | `renderer/core/mpv-player.js`（mpv 引擎）`renderer/core/player.js`（ffmpeg） |
| OSC 控制条显隐/图标/光标隐藏 | `renderer/ui/osc.js` |
| OSD 提示/中央图标/启动静默窗口 | `renderer/ui/osd.js` |
| idle 落地页/继续观看卡片/加载遮罩 | `renderer/app.js`（setIdleMode/showLoadingScreen/showResumeCard 段） |
| 窗口置顶/点击激活/画中画 | `main/index.js`（createWindow/窗口命令段） |
| 冒烟测试断言 | `main/smoke-test.js` |
| 续播逻辑 | `main/resume.js` |
| 字幕/弹幕自动加载 | `main/media-auto.js` |
| 文件关联/播放列表收集 | `main/file-assoc.js` |
| mpv 通信/属性 | `main/mpv-backend.js` |
| 配置键 | `main/config.js` + `renderer/app.js`（设置面板段） |

## 五、待拆分（下一步候选）

**拆分已完成（2026-08）**：index.js 3119→587、app.js 3590→606、register-ipc.js 614→21（拆出 ipc-player/media/window/app 四域）。全部按领域拆成自包含模块（主进程 15+ 模块、渲染端 13 模块）。剩余大文件（smoke-test 885 / settings 877 / mpv-backend 559 / subtitles 499 / config 465 / decoder 513）均为单职责模块，拆无收益。**后续想精简可做**：style.css（2666 行）按 UI 分区拆、或 index.js bootstrap 装配段挪 `bootstrap.js`（纯搬运，收益低）。

2. 拆分方法论（已固化）：统一 ctx 注入模式；每拆一块跑 `run-smoke.js` + `run-gui-test.js` 回归；**replace 后必须 grep 验证注入已生效**（text.replace 静默失败是坑）；**拆后双向扫描**（`node tools/scan-reverse-leaks.js <宿主> <全部模块>`——支持 CJS/ESM/require/module.exports/变量解构——①调用未导出函数 ②调用已导出但宿主漏 import；+ 技能自带 scan-module-refs.js 抓宿主符号漏网）
3. **坑（2026-08 实测）**：测试时若用户正开着播放器实例，共享默认 Chromium profile 被锁 → 渲染进程起不来、GPU cache 拒绝访问、应用异常退出 code 0（无任何报错）——务必用 `run-smoke.js` / `run-gui-test.js`（已内置独立 `--user-data-dir`）跑测试
4. **坑（2026-08 实测，词法器替换）**：①对象字面量属性键会被误伤（`config: config.toJSON()` 的键变 `getConfig():`）②对象简写属性（`{ mpvPath, config }` 变 `{ mpvPath, getConfig() }`）③**同名字段的属性键+属性访问**（`keybinds: keybinds.binds.length`、`player.audio.ready`）——精确模式优先于通用词替换；断言需跳过"前随 `.` 或后随 `:`"的标识符；**ctx 注入必须与访问器一致**（访问器读 `CTX.getKeybinds()` 就必须传 getter，传值会静默 null）
