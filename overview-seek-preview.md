# 进度条悬停缩略图预览 — 实现交付

## 功能
鼠标悬停（或拖动）进度条时，在 tooltip 上方浮出**该时间点对应的视频帧预览**，与 YouTube / PotPlayer 的 scrubbing 预览一致。

## 改动文件（6 个）
| 文件 | 改动 |
|---|---|
| `src/main/ffmpeg/seek-sheet.js` | 新增 **异步** `generateSheet()`（`execFile`+Promise）：ffmpeg 沿时间轴均匀抽帧拼成**精灵图**；`thumbnail.js` 本次**未改动**（被 sandbox 锁，留待本机清理同步版） |
| `src/main/ipc-media.js` | 新增 `app:seek-sheet` IPC handler |
| `src/main/preload.js` | 暴露 `window.lumen.getSeekSheet` |
| `src/renderer/index.html` | `#seekbar-zone` 内新增 `#seek-preview` 结构 |
| `src/renderer/ui/osc.js` | 载入触发拉取 + hover/drag 裁切预览逻辑 |
| `src/renderer/style.css` | 毛玻璃浮层样式 |

## 设计要点
- **单张精灵图 + 纯 CSS 裁切**：用 ffmpeg `fps=count/duration,scale=160:90,tile=8xN` 一次性拼出网格大图，渲染端按 `idx=⌊ratio*count⌋ → (col,row)` 用 `background-position` 裁切其中一格。相比逐帧生成 N 张缩略图，省一个数量级的 IPC 与解码开销。
- **按文件缓存**：精灵图按 `文件哈希 + 帧数 + 取整时长` 落盘到 `userData/thumbs`，二次 hover 零解码；渲染端再按 `path` 缓存一份，切回同一文件立即有预览。
- **过期丢弃**：`_sheetToken` 机制确保快速切歌时旧请求结果不会污染新文件的预览。
- **优雅降级**：纯音频 / 无视频流 → 主进程返回 `ok:false`，预览框永不显现；展示框仅在「有帧 + `.show`」时才透明显出，避免空框闪现。
- **设计语言统一**：浮层沿用 `--surface-2` / `--hairline` / `--text-1` / `--ease`，毛玻璃 `blur(18px) saturate(150%)`，定位浮在 tooltip 上方。

## 验证
- **未响应根因修复（本次重点）**：原 `thumbnail.js.generateSheet` 用**同步** `execFileSync` 在视频 `loaded` 时跑 ffmpeg 解码（约 0.8s），阻塞主进程事件循环 → Windows 报「未响应 / not responding」（画面照播是因为 mpv 独立渲染）。现抽出 `seek-sheet.js` 改用**异步** `execFile`+Promise，handler `app:seek-sheet` 以 `await` 调用，主线程不再被卡死。
- **本会话已跑通**：`node --check` 三个文件（seek-sheet.js / ipc-media.js / thumbnail.js）语法均 OK；`npm run lint:imports`（audit-imports）报告「未发现漏 import / 漏 require 类问题」。
- **ffmpeg 链路实测（上轮）**：`testmedia/sdr-1080p.mp4`（duration=120）输出精灵图 **1280×270**（8 列 × 3 行，24 帧），`ffprobe` 确认尺寸精确匹配，耗时 ~0.8s。
- **本会话未能跑的门禁（沙箱限制，非代码问题）**：`test:unit` / `typecheck` 全量扫描在沙箱内输出被吞、无法确认；`test:smoke` 需显示环境且本会话有卡死的 smoke 进程持锁。请你在本机跑 `npm run lint:syntax && npm run lint:imports && npm run test:unit && npm run typecheck && npm run test:smoke` 复核。

## 如何自测
1. 打开任意视频；
2. 鼠标移到进度条上 —— 约 1 秒内浮出缩略图预览（首次需生成精灵图），随光标左右移动切换帧；
3. 按住拖动进度条 —— 拖动过程中同步显示对应帧预览；
4. 切到下一集/下一文件 —— 旧预览自动失效，新文件载入后再次 hover 即出（命中缓存时瞬间出）。

## 待办
- **本会话改动尚未提交**：新增 `src/main/ffmpeg/seek-sheet.js`，修改 `src/main/ipc-media.js`（仅改 `generateSheet` 引入来源）。另有早前本地 commit（`d06cabc` 删除按钮滑入、`287563c` 竖条避让）未 push。
- 仓库为孤儿仓（本地 48 commit vs 远端 181 commit 无共同祖先），push 需 `git push --force-with-lease origin main`。待你在**本机**复核门禁 + 重启播放器确认「未响应」消失后，我再提交并强推。
- `thumbnail.js` 中那份同步 `generateSheet` 已无调用方，待本机解锁后删除（或改为 re-export 新模块）以彻底清理。
