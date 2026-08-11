# 路线 A：Windows Media Foundation 引擎（彻底去 GPL）

> 对应 `COMMERCIALIZATION.md` 的「路线 A」。
> 目标：**彻底不打包 `mpv.exe` / `ffmpeg.exe`**，改用 Windows 自带的
> **Media Foundation（MF）** 系统编解码器完成解封装与解码。
> 一举消除两类风险：
> 1. **GPL 义务** —— 不再分发任何 GPL 二进制；
> 2. **编解码器专利** —— H.264/AVC、AAC、HEVC/H.265 的专利责任随系统授权转移给 Microsoft。

---

## 0. 当前进展（2026-08-06 复核更新）

- **FFmpeg 已切 LGPL**（子目标达成）：发布构建改用 BtbN 的 `win64-lgpl` 变体，
  `bin/ffmpeg.exe` / `bin/ffprobe.exe` 已 `.gitignore`，由 `npm run fetch-deps`
  （`tools/fetch-ffmpeg.js`）拉取；`src/main/ffmpeg/binaries.js` 在启动时会检测并告警 GPL 构建。
  → **GPL 义务已从 ffmpeg 一侧彻底消除**。
- **ffmpeg 解码引擎已完整接入（可去 mpv 的 GPL 依赖）**：渲染端 `createEngine()`
  （`src/renderer/app.js`）在 `engine=ffmpeg` 时实例化 `Player`（`src/renderer/core/player.js`），
  这是一份**完整可用的 WebGL2 播放引擎**——自带 `Transport`（WebSocket 收帧）+ `FrameQueue`
  + `AudioOutput`（AudioWorklet）+ `MasterClock` + `VideoRenderer`（WebGL2），与 `MpvPlayer`
  同属 `PlaybackEngine` 契约。主进程 `MediaPipeline`（解码→`media-server`→WebSocket）与之对接；
  `ipc-player.js` 的 seek / set-speed / set-track / set-hwdec / stop 均已分支到 ffmpeg 管线；
  `play-control.js` 的 `loadFile` 在 `useMpv=false` 时启动管线并返回 `epoch` + `videoOutput`。
  设置面板「常规 → 播放引擎」已提供 mpv / ffmpeg 下拉切换（写入 player.conf，重启生效）；
  冒烟测试 `src/main/smoke-test.js` 已含 ffmpeg 分支断言。
  - **限制**：解码输出上限 1080p（`decoder.js` `MAX_OUTPUT_WIDTH=1920`，WebSocket 单帧 ~3MB 上限）；
    仍随附 ffmpeg 二进制（LGPL 构建，无 GPL 义务），故 `engine=ffmpeg` 可去除 **mpv** 的 GPL 依赖，
    但分发时仍包含 ffmpeg（LGPL）。
- **Media Foundation（路线 A）仍仅阶段 1**：`MediaFoundationEngine` 为占位，给出清晰报错而非白屏；
  后端 C++ N-API addon（阶段 2）尚未实现。故 `bin/mpv.exe` 当前仍不可移除（除非改用 `engine=ffmpeg`）。
- **结论**：要"彻底去除所有 GPL 二进制"，必须完成路线 A 的 **阶段 2/3**（实现
  `MediaFoundationBackend` C++ N-API addon + `MediaFoundationEngine` 接入），
  届时 `bin/mpv.exe` 与 `mpv-backend.js` 才能退役（阶段 4）。阶段 1（引擎抽象层）已完成。

---

## 1. 为什么现在就能动手（低侵入面）

现有代码已经把"播放后端"和"前端 UI"解耦得相当干净：

- `src/renderer/core/mpv-player.js` 的 `MpvPlayer` 是一份**现成的引擎契约实现**：
  它维护属性表、把用户操作翻译成 `window.lumen.mpvCommand/mpvSetProperty/seek` 等 IPC，
  并把后端推送的属性同步回 UI。OSC、stats、键位、脚本全部只跟这层接口打交道。
- `src/renderer/core/player.js` 的 `Player` 是一份**已完整实现并可用的 ffmpeg 引擎**（并非仅骨架）：
  自带 `Transport`（WebSocket 收帧）+ `FrameQueue` + `AudioOutput`（AudioWorklet）+ `MasterClock`
  + `VideoRenderer`（WebGL2），与 `MpvPlayer` 同属 `PlaybackEngine` 契约。它正是 ffmpeg 后端需要的
  "渲染端接收端"，且已上线可用（设置面板可切换 `engine=ffmpeg`）。路线 A 的 `MediaFoundationEngine`
  复用同一套渲染端接收端，只需替换主进程解码源。
- `src/main/media-server.js` 已实现了**本地 WebSocket 二进制帧传输**，可原样复用。

所以路线 A 的工程本质 = 把 `MpvPlayer` 抽成 `PlaybackEngine` 契约，
再写一个 `MediaFoundationEngine` 实现，由主进程拉起 MF 解码、通过
`media-server` 把帧/音频推给渲染端。前端改动极小。

---

## 2. 引擎契约（PlaybackEngine）

所有引擎实现必须遵守同一份契约，前端才能无感切换。契约由 `MpvPlayer` 提炼，
定义在 `src/renderer/core/engine.js`（见代码层交付）。

### 2.1 必须实现的方法

| 方法 | 签名 | 职责 |
|------|------|------|
| `init` | `init(bootstrap): Promise<this>` | 用配置初始化属性、注册后端事件监听 |
| `load` | `load(path): Promise<void>` | 打开文件，触发 `loaded` 事件 |
| `seek` | `seek(targetSec): Promise<void>` | 跳转；内部 clamp 到 `[0, duration]` |
| `frameStep` | `frameStep(dir: 1\|-1): void` | 逐帧；正向=暂停后步进，负向=回退 |
| `command` | `command(args: string[]): boolean` | 执行 mpv 风格命令（`set/add/cycle/seek/...`） |
| `getProperty` | `getProperty(name): any` | 读属性（派生量实时计算） |
| `setProperty` | `setProperty(name, value, silent?): void` | 写属性 + 必要副作用 |
| `observeProperty` | `observeProperty(name, cb): () => void` | 订阅属性变化（立刻回调一次当前值） |
| `onLoaded` | `onLoaded(payload): void` | 处理后端载入完成回调 |

### 2.2 共享状态形状（契约的一部分）

为避免 osc.js / stats.js 在切换引擎时 NPE，以下字段**必须存在**：

- `this.props`：属性表（与 `MpvPlayer` 字段完全一致）
- `this.info`：探测结果（`{ video[], audio[], subtitle[], chapters[], duration, hasAudio, path, title }`）
- `this.videoTrackInfo`：当前视频轨渲染参数
- `this.stats`：`{ renderedFrames, lastFrameTime, frameTimes[], avSync, lastPts }`
- 兼容桩（MF 后端未直接管理的子系统）：`queue / renderer / audio / transport / clock`
  —— 至少提供 `MpvPlayer` 中定义的形状，使旧代码不报错。

### 2.3 事件（EventTarget / CustomEvent）

| 事件 | detail | 触发方 |
|------|--------|--------|
| `loaded` | `{ info, output, epoch, resumeAt }` | 文件载入完成 |
| `eof` | — | 播放到末尾 |
| `property-change` | `{ name, value }` | 任一属性变化 |
| `osd` | `{ text, value? }` | 需要 OSD 提示 |
| `screenshot-request` | `{ mode }` | 截图命令 |
| `loadfile` | `{ path }` | 打开文件命令 |
| `playlist` | `{ action }` | 播放列表命令 |
| `script-binding` | `{ name }` | 脚本绑定 |
| `ab-loop-change` | `{ a, b }` | A-B 循环变化 |
| `vo-error` | `{ message }` | 视频输出失败（降级提示） |

---

## 3. Media Foundation 后端架构

```
  ┌──────────────── 主进程 (Node) ────────────────┐
  │                                                │
  │  MediaFoundationBackend (新增, N-API addon)    │
  │   ├─ IMFSourceReader 解封装+解码               │
  │   │   ├─ 视频 → D3D11 纹理 / RGBA 帧           │
  │   │   └─ 音频 → PCM (float)                    │
  │   ├─ 需求驱动流控(复用 _updateFlow 迟滞逻辑)   │
  │   └─ 通过 media-server WebSocket 推帧          │
  │                                                │
  └───────────────┬───────────────────┬───────────┘
                  │ 二进制帧/音频       │ IPC 命令
                  ▼                    ▼
  ┌──────────────── 渲染进程 ──────────────────────┐
  │  MediaFoundationEngine (前端引擎实现)           │
  │   ├─ Transport     ← media-server (复用)       │
  │   ├─ FrameQueue    ← 复用                       │
  │   ├─ AudioOutput   ← AudioWorklet (复用)       │
  │   ├─ MasterClock   ← 音频主时钟 (复用)         │
  │   └─ VideoRenderer ← WebGL2 (复用)             │
  └────────────────────────────────────────────────┘
```

### 3.1 解码实现选型

MF 是 COM API，Node 侧需通过以下之一调用：

| 方案 | 说明 | 取舍 |
|------|------|------|
| **C++ N-API addon** | 在 addon 内用 `IMFSourceReader` 解码，输出 RGBA 帧（或 D3D11 共享句柄）+ PCM | 性能最好、可控性最强；需维护编译链（msvc）。**推荐** |
| `ffi-napi` 调 COM | 纯 JS 经 ffi 调用 MF COM 接口 | 零编译，但 ffi 调用 COM 的 vtable 极繁琐、易崩、慢 |
| `edge` / `node-win` | 旧方案，维护停滞 | 不推荐 |

> 注意：即便用 MF，也只是"换了解码器"。帧数据最终仍交给渲染端的
> `VideoRenderer`（WebGL2）/ `AudioOutput`（AudioWorklet）消费，与旧 `Player` 管线一致。

### 3.2 专利责任

MF 调用的是 Windows 随附的编解码器 DLL（如 `msmpeg2vdec.dll` / `mfdecod.dll`），
其 H.264/AAC/HEVC 解码的专利授权已包含在 Windows 许可中。
**分发 Lumora 不再需要自行加入 Via LA / MPEG LA 专利池** —— 这是路线 A 相对
"自行打包 ffmpeg 解码" 的最大合规收益。

---

## 4. 与现有管线的对接点

| 现有模块 | 路线 A 中角色 | 改动量 |
|----------|--------------|--------|
| `media-server.js` | MF 后端经它推帧/音频 | **复用，几乎零改** |
| `core/transport.js` | 渲染端收帧入口 | 复用 |
| `core/framequeue.js` | 帧缓冲 + 丢帧 | 复用 |
| `core/audio.js` + `audio-worklet.js` | PCM → 扬声器 | 复用 |
| `core/clock.js` | 音频主时钟 | 复用 |
| `gl/renderer.js` | WebGL2 显示 | 复用 |
| `mpv-backend.js` | **退役**（路线 A 完成后删除） | 删除 |
| `ffmpeg/probe.js` | 探测可改用 MF 或保留 `ffprobe`(lgpl) | 替换/保留 |

---

## 5. 分阶段迁移

- **阶段 1（本次交付）**：引擎抽象层 `engine.js` + `MpvPlayer` 继承 + `MediaFoundationEngine` 占位
  + `config.js` 的 `engine` 选择字段 + `app.js` 工厂。mpv 路径行为不变，MF 路径给出清晰报错而非白屏。
- **阶段 2**：实现 `MediaFoundationBackend`（C++ N-API addon），经 `media-server` 推 RGBA/PCM。
- **阶段 3**：`MediaFoundationEngine` 接真实后端（去掉兼容桩，直连 `Transport`/`FrameQueue`）。
- **阶段 4**：移除 `bin/mpv.exe` / `bin/ffmpeg.exe`、`mpv-backend.js`，默认 `engine=mediafoundation`。
  此时 LICENSE 可恢复为商业闭源（GPL 义务消失），仅保留 Electron/Node/Chromium 的 MIT/BSD 声明。

---

## 6. 风险与验证

| 风险 | 说明 | 缓解 |
|------|------|------|
| 沙箱无 GPU | 当前运行环境无 GPU 会话，`VideoRenderer`（WebGL2）无法实测 | 用 `--smoke-test` 跑音频/逻辑断言；视频管线在真机验证 |
| COM 互操作复杂度 | `IMFSourceReader` 的媒体类型协商较繁琐 | 阶段 2 先做最小可用解码（H.264+AAC），再扩格式 |
| 格式覆盖 | MF 对某些格式（如 MKV 内部分封装）支持不如 ffmpeg 全 | 阶段 4 前补齐常见封装；罕见格式保留提示 |
| 性能 | 帧跨进程传输有开销 | 复用现有背压/迟滞逻辑；必要时走 D3D11 共享纹理（零拷贝） |

### 验证清单（每阶段末）

- [ ] 引擎抽象层不破坏 mpv 路径（启动 + 播放 + 键位）
- [ ] `engine=mediafoundation` 时不白屏，给明确"后端未实现"提示
- [ ] 阶段 2 后：H.264+AAC 可解、音画同步 ±40ms 内
- [ ] 阶段 4 后：安装包内无 mpv/ffmpeg 二进制；`THIRD_PARTY_LICENSES.md` 移除 GPL 节
