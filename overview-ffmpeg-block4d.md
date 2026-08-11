# Block #4d：ffmpeg 引擎接入收口

> 结论先说：**ffmpeg 解码引擎并非"缺渲染接入路径"——它早已完整接线并能用。**
> 本块的真正产出是：补一个回归开关 + 修正一份过时设计文档 + 校正项目记忆。

## 1. 复盘发现（关键）

按"挨个进行"顺序轮到 ffmpeg 接入时，逐文件追链路确认：整条管线**早已端到端打通**。

| 层 | 文件 | 状态 |
|---|---|---|
| 主进程引擎选择 | `src/main/index.js:288` | `useMpv = engine === 'mpv'`；非 MF 引擎即 `setupPipeline()` |
| 载入分支 | `src/main/play-control.js:87` | `else if (pipeline())` → `pipeline().start()` 返回 `epoch` + `videoOutput` |
| 命令路由 | `src/main/ipc-player.js` | seek / set-speed / set-track / set-hwdec / stop 均有 `else if (getPipeline())` 分支 |
| 背压 | `src/main/media-server.js` | socket 满只掐视频、音频独立迟滞（既有正确逻辑） |
| 帧投递 | `src/main/media-pipeline.js` | pipeline 事件 → media-server + 背压回调 |
| 渲染端引擎 | `src/renderer/app.js:166` | `engineName==='ffmpeg'` → `new Player(canvas)` |
| 渲染端引擎类 | `src/renderer/core/player.js` | 完整可用的 WebGL2 引擎：`Transport`+`FrameQueue`+`AudioOutput`+`MasterClock`+`VideoRenderer` |
| 配置下发 | `ipc-app.js:26` | bootstrap 含 `server.{port,token}`，供渲染端 `Transport.connect` |
| 设置 UI | `src/renderer/panels/settings.js:424` | 「常规 → 播放引擎」已有 mpv/ffmpeg 下拉（写 player.conf，重启生效） |
| 配置默认 | `src/main/config.js:116` | `'engine': 'mpv'` |
| 冒烟回归 | `src/main/smoke-test.js` | 已含 ffmpeg 分支断言（引擎感知、合成手势激活 AudioContext、帧流兜底） |

→ MEMORY.md 旧记 **"ffmpeg 模式(后端管线有、稳定渲染接入路径缺)"** 是 **2026-08-06 代码盘点时的过时结论**：当时信任了已过时的 `MEDIAFOUNDATION_ENGINE.md`（该文档第 0/1 节声称"渲染端没有对应的 WebGL2 播放引擎类 / engine=ffmpeg 会让画面无法渲染"——现已证伪）。

## 2. 本块实际交付

让"已接线"变为"可验证 + 文档准确"：

1. **`src/main/index.js`** — 新增 `LUMORA_ENGINE` 环境变量覆盖（仅内存生效、**不写回 player.conf**），用于：
   ```sh
   LUMORA_ENGINE=ffmpeg npm run test:smoke   # 在无头/CI 回归 ffmpeg 引擎
   ```
   并把有效 engine 写回 `config.values.engine`，使渲染端 bootstrap 与主进程判定完全一致（避免主进程走 ffmpeg、渲染端却建 mpv 引擎的错配）。

2. **`MEDIAFOUNDATION_ENGINE.md`** — 修正第 0 节与第 1 节：删除错误陈述，改为"ffmpeg 引擎已完整接入、可去 mpv 的 GPL 依赖、限制 ≤1080p（WebSocket 单帧 ~3MB 上限）、仍随附 ffmpeg LGPL 二进制"。路线 A（Media Foundation）仍仅阶段 1 占位，内容保持不变。

3. **`MEMORY.md`** — 移除"稳定渲染接入路径缺"，标记 ffmpeg 引擎 block#4d 已完成。

## 3. 门禁

| 门禁 | 结果 |
|---|---|
| 语法 `node --check src/main/index.js` | OK |
| 单测 `npm run test:unit` | 44/44 |
| 类型 `npm run typecheck` | 干净（RC=0） |
| 冒烟 | 未在沙箱重跑（开用户桌面真实窗口 + 无 GPU）；已补 `LUMORA_ENGINE` 开关供用户在真机回归 |

## 4. 提交

- 本地 `95a9c87`（仅 `src/main/index.js` + `MEDIAFOUNDATION_ENGINE.md`）
- 远端 Contents API 推送：`index.js → 3f43d5f`、`MEDIAFOUNDATION_ENGINE.md → ffdb12e`（PUSH_RC=0）

## 5. ffmpeg 模式的已知限制（如实记录）

- 解码输出上限 **1080p**（`decoder.js` `MAX_OUTPUT_WIDTH=1920`）；4K/8K 仍建议用 mpv。
- 仍随附 ffmpeg 二进制（LGPL 构建）——故 `engine=ffmpeg` 可去除 **mpv** 的 GPL 依赖，但分发时仍包含 ffmpeg（LGPL）。要"彻底零 GPL 二进制"仍需路线 A 的 Media Foundation 后端（阶段 2/3，C++ N-API addon，尚未实现）。

## 6. 下一步

按用户"挨个进行"顺序，**投屏（DLNA/Chromecast）** 现在是唯一剩余的真·功能缺口（MF 引擎仍仅阶段 1 占位）。
