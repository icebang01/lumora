# Lumen 播放器 — 商用化接力交接文档

> 更新时间：2026-08-04 03:11  
> 当前状态：播放列表/媒体库（P0）功能已实现并通过自动化测试；8K 性能优化已完成；Lumen 进程当前未运行（需手动启动）

---

## 一、已完成的全部工作（按时间线）

### 阶段 1：战略与设计
| # | 任务 | 交付物 |
|---|------|--------|
| 1 | 商用化战略 | `COMMERCIALIZATION.md` |
| 2 | 品牌设计系统 | `DESIGN.md`（9 章节，暗色玻璃拟态） |
| 3 | GPL 许可确认 | `THIRD_PARTY_LICENSES.md` 更新 |
| 4 | Media Foundation 技术方案 | `MEDIAFOUNDATION_ENGINE.md` |

### 阶段 2：Bug 修复
| # | Bug | 根因 | 修复 |
|---|-----|------|------|
| 5 | 设置弹窗双击穿透 | `isUiTarget()` 白名单漏设置面板 | 补齐白名单 |
| 6 | 设置功能不生效 | engine=mediafoundation 崩溃 + 硬编码 | 改 engine=mpv + 即时生效 |
| 7 | mpv IPC 连接超时 | idle 时隐藏 videoWin 致 D3D11 失败 | 四模式回退 + 启动期保持可见 |
| 8 | F 键无法退出全屏 | videoWin 抢焦点 | `focusable: false` |
| 9 | 键位面板无法关闭/拖动 | 缺 no-drag 隔离 | 补 `-webkit-app-region: no-drag` |

### 阶段 3：文件关联 + 继续观看 UI（P0）
- `src/main/resume-store.js`：续播快照读写
- `src/main/index.js`：HKCU 注册表文件关联、second-instance → `app:open-file`
- `src/renderer/app.js`：idle 屏续播卡片、`app:open-file` 监听
- `package.json`：`build.fileAssociations`（23 种扩展名）
- 测试：`--test-file-assoc`（PASS）、`--test-resume`（PASS）

### 阶段 4：idle 屏排版微调（用户多轮反馈）
- 继续观看卡片居中：`margin: auto` + `width: 100%; max-width: 420px`
- 快捷键提示区域：左列贴左、右列贴右、kbd 紧凑不留空
- CSS 版本戳 `?v=9` 防缓存

### 阶段 5：播放列表/媒体库（P0）← 刚完成
| 文件 | 改动 |
|------|------|
| `src/main/playlist-store.js` | **新建**。items[] + currentIndex 持久化（userData/playlist.json） |
| `src/main/index.js` | `collectMediaFromSelection()` 展开文件夹；`player:open-dialog` 支持多选+目录；`playlist:load`/`playlist:save` IPC；bootstrap 带 playlist 状态；`--test-playlist` 测试 |
| `src/main/preload.js` | bridge 加 `getPlaylist()`/`savePlaylist()` |
| `src/renderer/app.js` | `setPlaylist`/`playlistJump`/`playlistGoto`/`playlistRemove`/`persistPlaylist`/`renderPlaylist`/`togglePlaylistPanel`/`closePlaylistPanel`/`bindPlaylistPanel`；`runCommand` 路由 `playlist-next`/`playlist-prev`/`show-playlist`；boot 恢复持久化列表；EOF 自动下一首；`app:open-file` 追加 |
| `src/renderer/index.html` | `#playlist-panel` 面板 HTML（列表 + 计数 + 关闭按钮） |
| `src/renderer/style.css` | 播放列表面板样式（暗色玻璃拟态，DESIGN.md 风格） |
| `.cache/app.mjs` | 已同步更新 |
| 测试 | `--test-playlist` **PASS**（6/6 检查全通过） |

### 阶段 6：8K 性能优化 + UI 加固（2026-08-02）← 补充记录
| 文件 | 改动 |
|------|------|
| `src/main/mpv-backend.js` | 启动参数新增缓存（`--cache=yes` + `--demuxer-readahead-secs=20` + `--demuxer-max-bytes`），多线程解码（`--vd-lavc-threads=<物理核心数>` + `--vd-lavc-fast=yes`），帧丢弃（`--framedrop=decoder+video`），视频同步（`--video-sync=display-resample`），GPU 优化（Windows `--gpu-api=d3d11` + `--swapchain-depth=4`）；新增 `_cpuCores()` 与 `applyResolutionProfile(w,h)` |
| `src/main/index.js` | `loadFile()` 后调用 `mpvBackend.applyResolutionProfile()` 按分辨率自适应 |
| `config/player.conf` | 新增 `adaptive-scaler` / `vd-lavc-threads` / `demuxer-readahead-secs` / `framedrop` 配置项 |
| `src/main/index.js` | 双窗口 z-order 修复：`win.on('focus')` + `mouse-down` 联动 `videoWin.moveTop()` |
| `src/renderer/index.html` / `style.css` / `ui/osc.js` | OSC 悬浮胶囊化（毛玻璃 + 圆角 18px + 多层阴影）；新增停止/逐帧/AB 循环/循环模式/字幕/截图/画中画 7 个按钮 |
| `src/renderer/app.js` | `setIdleMode()` 统一管理 idle 状态，修复"取消文件对话框后黑屏"bug（6 个调用点统一入口） |

**8K 优化要点**：
- 8K 下 `applyResolutionProfile()` 把缩放算法降级为 `bilinear`（EWA Lanczos 每像素需 ~441 次纹理采样，GPU 必然过载），缓存加到 30s，关闭去带
- 4K 用 `spline36` 折中；≤1080p 恢复 `ewa_lanczos`
- 根因：mpv 后端此前零性能参数，8K 每帧约 50MB 直接卡死

**注意事项**：
- `--demuxer-max-bytes` 在该 mpv 构建（v0.41.0）不接受 `MiB`/`M` 后缀，原代码用错导致 mpv 启动即退出（code=1）；当前已移除该参数，改用 `--cache=yes` + `--demuxer-readahead-secs` 组合
- 沙箱无 GPU 时 mpv 四模式全部失败属预期，不影响 UI 逻辑与自动化测试

### 阶段 7：播放列表循环模式（2026-08-04 接力）← 新增
| 文件 | 改动 |
|------|------|
| `src/renderer/app.js` | 新增 `loopMode` 状态机（off/list/file/random）、`setLoopMode()`/`cycleLoopMode()`；重写 `playlistJump()` 支持随机选位；`eof` 事件按模式分流（file 模式 mpv 原生重播、list/random 自动续播、off 播到列表尾结束）；抽 `endOfPlaylist()`；命令路由 `loop-mode-cycle`/`loop-mode-set`；暴露 `__setLoopMode`/`__getLoopMode`/`cycleLoopMode` 测试钩子 |
| `src/renderer/ui/osc.js` | `btn-loop` 点击走 `window.__lumen.cycleLoopMode()`；`paintLoop` 改为事件驱动（`lumen:loopmode`），支持四态图标 |
| `src/renderer/index.html` | `btn-loop` 去掉无效的 `data-cmd`；新增 `icon-loop-random` SVG |
| `src/shared/default-keybinds.js` | L 键从无效 `cycle-values loop-file inf no` 改为 `loop-mode-cycle` |
| `src/main/index.js` | 新增 `--test-loopmode` 自动化测试（`runLoopModeTest`） |

**要点**：
- 四态循环 `off → list → file → random → off`，点击按钮或按 L 键切换
- 单曲循环（file）交给 mpv 原生 `loop-file=inf` 处理；列表/随机循环由 Lumen 自管（播放列表是 Lumen 自管，mpv 的 `loop` 列表循环对我们无效）
- `--test-loopmode` **PASS**：四态顺序正确、random 模式每次跳不同位置

---

## 二、当前任务清单状态

```
✅ #1  调研 Lumen 播放器现状
✅ #2  产出商用化战略文档
✅ #3  更新项目记忆
✅ #4  产出商用品牌设计系统 DESIGN.md
✅ #5  更新 THIRD_PARTY_LICENSES
✅ #6  写路线 A 技术方案
✅ #7  语法校验与重启验证
✅ #8  实现引擎抽象层与选择开关
✅ #9  检查设置面板各功能是否真正生效
✅ #10 修复 mpv 启动失败
✅ #11 修复 F 键无法退出全屏 + 键位面板
✅ #12 实现文件关联
✅ #13 实现继续观看 UI
✅ #14 为两个新功能加自动化测试
✅ #15 设计播放列表数据模型与 IPC 接口
✅ #19 实现主进程 playlist-store.js
✅ #20 主进程 index.js 集成播放列表
✅ #21 渲染进程播放列表面板 UI
✅ #22 OSC 加导航按钮 + 快捷键
✅ #23 自动化测试 + 重启验证
✅ #24 四态循环模式状态机（app.js）
✅ #25 OSC 按钮+四态图标+L 键+--test-loopmode
```

**全部 20 个任务已完成。**

---

## 三、下一步待做（接力人从这里开始）

### P0 — 发布前必做

1. **真机验证播放列表功能**
   - 沙箱无 GPU，mpv 必失败；以下功能只能在真机验证：
   - 打开多个文件 → 列表建立 → 自动续播
   - 打开文件夹 → 自动展开媒体文件入队
   - `>` / `<` 键上一首/下一首
   - `F8` 键打开播放列表面板
   - 双击列表项跳转
   - 列表项 ✕ 按钮移除
   - 关闭重开 Lumen → 列表恢复

2. **许可合规收尾（路线 B）**
   - 补全 `THIRD_PARTY_LICENSES.md`（mpv/ffmpeg 全量依赖列表）
   - 核对 mpv（GPLv2+）与 ffmpeg（GPL）许可兼容性
   - 规划 ffmpeg 替换为 LGPL 动态链接构建方案
   - 确认 electron-builder 打包后的许可文件分发合规

3. **品牌/商标决策**
   - 「Lumen」同名项目较多，需做商标检索
   - 确定 logo、启动画面、installer 视觉
   - 如果更名，全局替换需覆盖：package.json、index.html、HKCU 注册表 ProgID、DESIGN.md

### P1 — 体验优化

4. **Media Foundation 引擎（路线 A）**
   - `MEDIAFOUNDATION_ENGINE.md` 技术方案已写好
   - 用系统解码器彻底去 GPL、规避专利
   - 大工程，需要真机有 GPU 才能验证
   - 当前 engine 选项已从设置面板移除（仅留 mpv），代码保留 PlaybackEngine 抽象

5. **播放列表增强**
   - 拖拽排序列表项
   - 列表项缩略图（从 ffprobe 取首帧）
   - "添加到列表" vs "替换列表" 的 UX 选择
   - ~~循环模式（单曲循环 / 列表循环 / 随机）~~ → **已完成（阶段 7）**

6. **idle 屏体验**
   - "打开文件夹"按钮（目前只有"打开文件"）
   - 最近播放历史（不同于续播，是最近 10 个文件的列表）

### P2 — 长期

7. **媒体库**（从播放列表进化到媒体库）
   - 扫描指定目录，建立媒体索引
   - 按文件名/类型/分辨率分组展示
   - 搜索/排序

---

## 四、关键文件索引

```
项目根：D:\IDEA\videos\

主进程 (CommonJS)：
  src/main/index.js          — 主入口，窗口管理、IPC、文件关联、测试
  src/main/mpv-backend.js     — mpv 子进程管理，四模式回退
  src/main/playlist-store.js  — 播放列表持久化
  src/main/resume-store.js    — 续播快照持久化
  src/main/config.js          — 配置系统（DEFAULTS + player.conf）
  src/main/preload.js         — contextBridge 桥接

渲染进程 (ESM)：
  src/renderer/app.js         — 主逻辑（播放器、播放列表、命令总线、idle 屏）
  src/renderer/index.html     — UI 结构
  src/renderer/style.css      — 全部样式（DESIGN.md 暗色玻璃拟态）
  src/renderer/ui/keymap.js   — 键位速查面板

共享：
  src/shared/default-keybinds.js — 默认键位映射（mpv 兼容）

设计/文档：
  DESIGN.md                   — 品牌设计系统（9 章节）
  COMMERCIALIZATION.md        — 商用化战略
  MEDIAFOUNDATION_ENGINE.md   — MF 引擎技术方案
  THIRD_PARTY_LICENSES.md     — 开源许可声明
```

---

## 五、启动与测试命令

```bash
# 正常启动
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe .

# 自动化测试
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe . --test-open-settings
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe . --test-file-assoc
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe . --test-resume
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe . --test-playlist

# 杀进程（taskkill 在沙箱无效，用 WMI）
# PowerShell: Get-WmiObject Win32_Process -Filter "Name='electron.exe'" | ForEach-Object { $_.Terminate() }

# 语法检查
node --check src/main/index.js
cp src/renderer/app.js _tmp.mjs && node --check _tmp.mjs && rm _tmp.mjs

# 更新渲染端缓存（修改 app.js 后必须）
cp src/renderer/app.js .cache/app.mjs
```

---

## 六、已知限制与注意事项

1. **沙箱无 GPU**：mpv 四模式全部失败（d3d11/gpu-auto/opengl/audio-only），UI 逻辑正常
2. **CSS 缓存**：修改 style.css 后必须升 `index.html` 里的 `?v=N` 版本戳
3. **app.js 缓存**：修改 app.js 后必须同步 `.cache/app.mjs`，否则渲染端加载旧代码
4. **单实例锁**：残留 electron 进程会阻止新实例启动，必须先 WMI 杀干净
5. **`ELECTRON_RUN_AS_NODE`**：从宿主继承会导致 electron 以 node 模式启动，必须 `env -u` 去除
6. **文件关联注册表**：`registerFileAssociation()` 写 HKCU，沙箱无法验证，需真机点一次设置开关
7. **idle 屏快捷键排版**：经过多轮微调，当前为左列贴左、右列贴右（`1fr auto` grid），用户认可
