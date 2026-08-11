# mpv 启动失败 — 根因与修复

## 现象
播放器每次启动都弹「mpv 启动失败」致命红框。

## 根因
`src/main/mpv-backend.js` 的 `_baseArgs()` 里 `--framedrop=decoder+video` 在 mpv v0.41.0 是
**非法值**（framedrop 只接受 `no` / `vo` / `decoder`）。

mpv 在**参数解析阶段**即退出码 1，且 stderr 被吞（空），伪装成「`--wid` 嵌入失败」。
由于四种启动模式（d3d11 / gpu-auto / opengl / audio-only）都带这个非法参数，
全部失败 → `index.js` 走 catch → 发 `player:error` → 渲染端弹致命红框。

> 之前误诊为「沙箱无 GPU / `--wid` 嵌入失败」，实际是非法参数所致。修正后
> d3d11 模式在当前环境可正常启动并连上 IPC。

## 修复清单
| 文件 | 改动 |
|------|------|
| `src/main/mpv-backend.js` `_baseArgs` | `--framedrop=decoder+video` → `--framedrop=decoder` |
| `src/main/mpv-backend.js` `applyResolutionProfile` | 同上（8K 分支里的同值） |
| `src/main/mpv-backend.js` audio-only 变体 | 去掉 `--wid`（无 GPU 时不嵌入，纯音频常驻） |
| `src/main/mpv-backend.js` `_baseArgs` | 去掉不稳定的 `--demuxer-max-bytes=800MiB` / `--demuxer-max-back-bytes=200MiB` |
| `src/main/mpv-backend.js` `start()` | 记录 `this.activeMode = name` |
| `src/main/index.js` | audio-only 兜底成功时发 `player:degraded`（友好降级）而非 `player:error`（致命红框） |
| `src/main/preload.js` | INBOUND 白名单加 `'player:degraded'` |
| `src/renderer/app.js` | 加 `player:degraded` handler → 复用 `warnNoVideoOutput()` 显示「已切换为纯音频模式」 |

## 验证
- 二分实测：单独测 `--framedrop=decoder+video` 报 `Invalid value for option framedrop`，
  其余参数（hwdec / swapchain / cache / lavc / seek / osc / msg）均合法。
- 改后重启日志：`[mpv] 启动成功: d3d11` + `[mpv] 后端已启动`，**不再弹「mpv 启动失败」**。

## 遗留
mpv 进程与 IPC 在沙箱可正常启动，但**视频画面是否真正渲染仍取决于 GPU 可用性**
（无 GPU 时可能仍黑屏）；纯音频兜底已在无 GPU 时可用。
真机（有独立显卡）上 d3d11 嵌入应正常出画面。
