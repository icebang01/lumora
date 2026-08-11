# Lumen 播放器 — 流控修复总结

## 问题

"有声音无画面"：播放器启动后只有声音，视频画面始终黑屏。

## 根因分析

### Bug 1：throttle() 共用信号（有声音无画面）

`decoder.js` 的 `throttle(paused)` 方法同时 pause/resume 音频和视频的 stdout。但音频和视频的数据率差两个数量级：
- 音频：~16KB/包，几十毫秒就攒满 2 秒缓冲
- 视频：~3.1MB/帧（1080p yuv420p），需要 ~32 个 chunk 才能凑够一帧

音频缓冲快速填满触发 `throttle(true)` → 视频 stdout 被 pause → 视频帧永远凑不够 → 画面出不来。

### Bug 2：socketFull 同时掐音频（丢帧率 310/8）

修复 Bug 1 后，视频 stdout 不再被 throttle，ffmpeg 全速解码导致帧队列溢出。`socketFull` 信号（socket 缓冲 >12MB ≈ 4 帧 1080p）触发时同时 pause 音频和视频，导致音频断流、时钟停摆。

## 修复方案

### 独立音视频流控

将单一 throttle 信号拆分为独立的音频和视频通道，各自有独立的迟滞水位：

```
渲染端 _updateFlow()
  ├── 视频需求：队列 >= 11 → 停喂；<= 6 → 恢复
  └── 音频需求：缓冲 > 2s → 停喂；< 1s → 恢复
       ↓
transport.setDemand({audio, video})
       ↓ WebSocket
media-server._applyThrottle()
  ├── audioThrottled = rendererAudioFull（不含 socketFull）
  └── videoThrottled = socketFull || rendererVideoFull
       ↓
decoder.throttle({audio, video})
  ├── audioProc.stdout.pause/resume
  └── videoProc.stdout.pause/resume
```

### socketFull 只控视频

视频帧大（3MB）是 socket 缓冲积压的元凶；音频包小（16KB）不会导致 socket 满。`socketFull` 只 pause 视频 stdout，不影响音频。

## 修改文件

| 文件 | 改动 |
|------|------|
| `src/renderer/core/transport.js` | `setDemand({audio, video})` 分离流控消息 |
| `src/renderer/core/player.js` | `_updateFlow()` 独立迟滞水位 + 清理诊断日志 |
| `src/main/media-server.js` | 分离 `rendererAudioFull`/`rendererVideoFull` + socketFull 只控视频 |
| `src/main/ffmpeg/decoder.js` | `throttle({audio, video})` 分别控制 stdout + 清理诊断日志 |
| `src/main/index.js` | 清理 setupPipeline 诊断日志 |

## 测试结果

```
=== Lumen 冒烟测试 ===
  PASS  渲染端完成初始化
  PASS  WebGL2 上下文可用
  PASS  浮点渲染目标可用（HDR 管线前提）
  PASS  媒体流通道已连接
  PASS  音频输出就绪
  PASS  键位表已载入   87 条
  PASS  用户脚本无加载错误
  PASS  媒体文件载入成功
  PASS  时长解析正确   20.00s
  PASS  播放推进（时间码前进）
  PASS  音频缓冲未溢出（背压有效）
  PASS  音频时钟在走
  PASS  视频帧持续送达   62 帧 / 丢 7
  PASS  音画同步在 ±40ms 内   16.0ms
  PASS  像素格式已协商   yuv420p 1920×1080
  PASS  画面非全黑（GPU 回读）
  PASS  画面有内容变化（非纯色）
  PASS  跳转到达目标位置
  PASS  跳转后代际号递增
  PASS  暂停态跳转已呈现目标帧
  PASS  跳转后播放恢复
  PASS  跳转后帧流恢复
  PASS  暂停命令生效
  PASS  音量属性可写
  PASS  静音开关可切
  PASS  倍速属性可写
  PASS  去色带开关可切
  PASS  缩放算法可轮换
  PASS  色彩均衡可写
  PASS  切换渲染选项后画面仍正常
  PASS  逐帧前进一帧
  PASS  统计面板可开启

结果：32/32 项通过
```
