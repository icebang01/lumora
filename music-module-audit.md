# Lumora 音乐模块 — 竞品对比与查漏补缺审计报告

> 审计日期：2026-08-08
> 审计范围：`src/renderer/ui/music-stage.js`、`src/renderer/app.js`、`src/renderer/core/audio.js`、`src/renderer/index.html`、`src/renderer/style.css`
> 竞品基准：Apple Music / Spotify / 网易云音乐 / QQ音乐 / YouTube Music / 桌面播放器（foobar2000, MusicBee, AIMP）

---

## 一、功能矩阵（✅ 已实现 / ❌ 缺失 / ⚠️ 部分或需插件）

| 功能 | Apple Music | Spotify | 网易云 | QQ音乐 | YT Music | 桌面播放器 | **Lumora 现状** |
|---|---|---|---|---|---|---|---|
| 循环模式（关/列表/单曲/随机） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ **已实现** `app.js:732-809` |
| 歌词 + 卡拉OK 扫光 | ✅(Sing) | ❌ | ✅ | ✅ | ❌ | ⚠️插件 | ✅ **已实现**（连续 `--prog` 擦除，`music-stage.js:565-647`） |
| 歌词时间偏移校正 | ❌ | ❌ | ⚠️ | ⚠️ | ❌ | ⚠️ | ✅ **已实现**（偏移条 + 按路径持久化） |
| 实时频谱可视化 | ⚠️ | ❌ | ⚠️ | ✅ | ❌ | ✅ | ✅ **已实现**（真实 FFT，`audio.js` AnalyserNode） |
| 拖动 seek / 进度 / 音量 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ **已实现** |
| 播放列表 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ **已实现**（单列表容器） |
| **收藏 / 红心（Like）** | ✅ | ✅ | ✅ | ✅ | ❌(👍) | ⚠️ | ❌ **缺失** |
| **音频均衡器 EQ** | ⚠️ | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ **缺失**（仅有视频 `reset-video-eq`） |
| **迷你播放器** | ✅ | ✅(桌面) | ✅ | ✅ | ✅ | ✅ | ❌ **缺失** |
| **系统媒体控制**（MediaSession / SMTC / MPRIS / 媒体键） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ **缺失** |
| **睡眠定时** | ⚠️ | ❌ | ✅ | ✅ | ❌ | ⚠️ | ❌ **缺失** |
| **歌词翻译** | ⚠️ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ **缺失** |
| **Up-next 播放队列 UI** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ 无专属 UI（仅 playlist 容器） |
| **交叉淡入 / 无缝播放** | ⚠️(AutoMix) | ❌ | ⚠️ | ⚠️ | ❌ | ✅ | ❌ **缺失** |
| **桌面歌词** | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ **缺失** |

---

## 二、缺失项技术评估与优先级

### 🟢 Tier 1 — 高价值、低~中门槛（建议第一批）
1. **系统媒体控制（MediaSession API）**
   - 价值：桌面播放器标配。锁屏/任务栏缩略图控制、键盘媒体键（播放/暂停/上一首/下一首）、系统通知。缺失是「不像正经音乐播放器」的最大短板。
   - 实现：渲染端 `navigator.mediaSession` 设置 `metadata` + `setActionHandler(play/pause/previoustrack/nexttrack/seekto)`；桥接 `window.lumen` 的 play/pause/next/prev/seek；mpv/ffmpeg 引擎状态变化回写 `playbackState`。纯渲染 + 轻量 IPC，**无需动音频管线**。
   - 工作量：中（约 1 个模块 + app.js 桥接）。

2. **收藏 / 红心 + 睡眠定时（打包）**
   - 收藏红心：渲染端心形按钮 → 按媒体路径存 `localStorage`/`playlist-store` liked 集合 → 播放列表高亮 + 筛选「我喜欢的」。
   - 睡眠定时：渲染端计时器（15/30/45/60min + 自定义）→ 到点渐隐音量并 pause。低门槛、高感知。
   - 工作量：低~中（两个独立小功能）。

### 🟡 Tier 2 — 中价值、需音频管线或数据源
3. **迷你播放器模式**
   - 桌面常驻小窗（封面 + 曲名 + 极简控制）。Electron 需新 `BrowserWindow` 或主窗 compact 态。
   - 工作量：中~高（窗口管理 + 复用 music-stage 组件）。

4. **音频均衡器 EQ**
   - ffmpeg 路径已在 `audio.js` 有 `AudioContext` + AnalyserNode → 可在 worklet 输出后插入 `BiquadFilterNode` 链（10 段 graphic EQ / 预设）。mpv 路径用 `af=equalizer`。
   - 工作量：中。

5. **Up-next 播放队列 UI**
   - 复用现有 playlist 容器，新增「当前播放位置 + 后续列表」可视化 + 「播放下一首」插队。
   - 工作量：低~中。

6. **歌词翻译**
   - 依赖歌词源返回译文（网易云/QQ scraper 已有，需确认返回 translation 字段）。渲染端双行展示。
   - 工作量：中（取决于 scraper 字段）。

### 🔴 Tier 3 — 锦上添花、门槛高
7. **交叉淡入 / 无缝播放（Crossfade / Gapless）**
   - Gapless：mpv 对容器支持良好，基本免费；Crossfade 需音频引擎混音（double-buffer / 重叠淡出）。
   - 工作量：高。

8. **桌面歌词**
   - 独立 always-on-top 透明窗口，常驻桌面歌词。
   - 工作量：高。

---

## 三、结论
Lumora 音乐模块的**核心播放体验（歌词扫光、时间偏移、频谱、循环、seek）已领先多数竞品**，短板集中在**外围生态能力**：系统媒体控制、收藏、迷你模式、EQ、睡眠定时、歌词翻译、播放队列 UI。

建议第一批落地 Tier 1（系统媒体控制 + 收藏红心 + 睡眠定时）—— 用最小代价补齐「正经音乐播放器」的体感门槛，再视反馈推进 Tier 2/3。
