# Lumora 真机验证清单（Real-Device Checklist）

> 用途：本仓库的若干验收项**只能在真实机器上完成**——沙箱无 GPU / 无投屏设备 / 无真实音频输出，
> 无法自动验证。本清单把这些都列成可逐步执行、带「通过标准」的脚本，供在本机（Windows + 独立显卡）运行。
>
> 环境前提：本机需 `git` 已对齐 `origin/main`（443 恢复后 `git push` 快进；或 `git fetch && git reset --hard origin/main`），
> 且 `npm install` 后 `npm run rebuild-mf`（如需 MF 原生引擎）。
>
> 关联状态：设计交付八件套 + DESIGN.md 已闭环；Crossfade 渲染端单测 14/14 绿（harness 已修，`4e35b35`）；
> **443 推送积压 78 提交待对齐**；下列项均为 sandbox-impossible，需本机目测。

---

## 1. 黑胶唱机 ≤480 窄窗目测（vinyl / glass 样式）

- **前置**：进入音乐模式（audio-mode）；设置 → 音乐样式切到 `style-vinyl` 或 `style-glass`。
- **步骤**：
  1. 播放一首带封面的曲目，确认封面渲染正常（曾因 `cc964f2` 修过封面不显示）。
  2. 将窗口宽度拖到 **≤480px**（同步观察高度 ≤560h 的堆叠行为）。
  3. 切到 `style-glass`（透明彩胶）重复一次。
- **通过标准**：
  - 唱臂落点正确（暂停/播放双态由 `.playing` 驱动，落点角度与校准一致，不越界）。
  - 转盘/唱臂**绝对定位不挤压歌词**区域；`≤720` 已做 `.ms-content` 堆叠，但唱机绝对定位需肉眼确认无重叠。
  - 无元素溢出视口（参考 `e7a27a6` 已修 `.eq-window`/`#stats-panel` 窄窗溢出）。
- **已知风险**：`style-vinyl`/`style-glass` 在极窄窗下唱机绝对定位曾未确认（memory 红线：未在真机目测前不擅改视觉）。

## 2. MF 引擎视频连续性（默认引擎 = mediafoundation）

- **前置**：`config.js` 默认引擎已为 `mediafoundation`；原生 `.node` 未编译或非 Windows 时自动回退 ffmpeg（不启动 mpv）。
- **步骤**：
  1. 播一段 **5.1 声道 / HDR / 4K / 隔行** 视频，确认完整播完无中断（此前验证过 5.1 音频 `recvAudio #1700≈72s`）。
  2. 中途 **seek** 多次（含大跨度），确认无黑闪、无音画错位。
  3. 改变窗口尺寸（触发 nudge 强制 mpv 重绘），确认无首帧黑闪（参考 `440d398` 首帧黑闪终极修复：瞬切 + 绝对时间锚点 `LOADING_ANCHOR_MS=1200` + 三重闸门）。
  4. 检查 `video-out-params` 正常、`vo-reconfig` 稳定。
- **通过标准**：长片连续播放、seek/resize 无黑闪、A/V 同步误差在可接受范围（音频主时钟）。

## 3. DIAL 投屏真机验证（v2 新增协议）

- **前置**：一台支持 DIAL 的设备（如带 YouTube 应用的智能电视/盒子），与本机同 Wi-Fi。
- **步骤**：
  1. 打开投屏面板（cast panel），确认设备列表中出现 **DIAL 类型徽章（蓝 `#8ab4ff`）** 的设备（如 NVIDIA SHIELD）。
  2. 点「连接」，确认状态条变绿（`已连接：<设备> · …`）。
  3. 点「投屏当前内容」或填入一个 YouTube 串流 URL 点「投屏」，确认设备端启动对应应用并拉起播放。
- **通过标准**：
  - 发现 + 连接 + launch 成功；设备端应用自行拉取 URL 播放。
  - 认知边界：**DIAL 仅能 launch 应用，无通用 pause/seek/volume**——传输控制（暂停/继续/停止/同步进度）在 DIAL 设备下应表现为「不支持」提示而非静默失败。
- **注意**：Chromecast 投屏需用户自备标准 Cast 客户端证书+私钥+salt（配置项 `cast.chromecastCert/Key/Salt`），模块不内置。

## 4. Crossfade 主进程调度（渲染端已绿，主进程待连通验证）

- **背景**：渲染端编排（`player.js` 代际守卫 / equal-power 斜坡 / 副声部提升 / 取消 / EOF 退化）+ 音频（`audio.js`）+ 解码器（decoder）三套单测共 **14/14 绿**，但单测中 `window.lumen.crossfadeStart/Cancel` 为 **mock**。
  **主进程侧 `ipc-player.js` / `media-pipeline.js` 的 crossfade 调度是否真正连通**（双声部同时解码、无缝过渡）需真机验证。
- **前置**：设置中开启 Crossfade（淡入淡出接歌）并设置过渡时长（如 2.0s）。
- **步骤**：
  1. 播放曲目 A，临近曲尾（剩余 ≈ 过渡时长）观察是否起 equal-power 斜坡（主声部淡出 / 副声部淡入）。
  2. 到点确认副声部提升为主声部、旧主声部槽位回收、player.duration 更新为新曲（无听感凹陷：a²+b²≈1）。
  3. 验证**代际守卫**：快速连切两首，确认旧曲的迟到 started 事件不建出双音。
  4. 播放中手动「取消」交叉淡入淡出，确认副声部释放、主声部恢复满音量。
  5. 副声部未就绪时主声部 EOF：确认退化为普通切轨（防无声卡死），不卡死。
- **通过标准**：两曲间无缝、无双音、无静音卡死；取消/EOF 降级正常。

## 5. 通用冒烟（smoke）

- `npm run test:smoke testmedia/sdr-1080p.mp4`（真实 Electron + mpv d3d11，沙箱可跑但本机更稳）。
- 确认：播放/暂停/seek/倍速/音量/字幕/循环/续播/截图/全屏/画中画/滤镜/HDR/hwdec/统计 全功能可用。
- 运行 `npm test` 确认全量单测仍 135/135 绿（本次 harness 修复后基线）。

---

## 待办状态汇总

| 项 | 状态 | 阻塞 |
|---|---|---|
| 设计交付（8 mock + DESIGN.md） | ✅ 完成 | — |
| Crossfade 渲染端单测 | ✅ 14/14 绿（`4e35b35` 修 harness） | 主进程调度见 §4 |
| 443 推送（本地领先 78 提交） | ⏳ 待网络 | github.com:443 间歇断连 |
| §1 黑胶 ≤480 目测 | ⏳ 待本机 | 无 GPU/设备 |
| §2 MF 视频连续性 | ⏳ 待本机 | 无 GPU |
| §3 DIAL 真机 | ⏳ 待本机 | 无投屏设备 |
| §4 Crossfade 主进程 | ⏳ 待本机 | 无真实音频 |
| §5 通用冒烟 | ⏳ 待本机 | — |
