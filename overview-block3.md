# Lumora · Block #3：鼠标手势 + 操作手感

> 顺序完善路线第三块（书签+章节UI → 主题切换+截图序列 → **鼠标手势+操作手感** → 网络串流/投屏）。
> 本地提交 `bc42384`，远端经 Contents API 推送（PUSH_RC=0）。

## 做了什么
在**画面区域按住左键拖动**触发手势，与现有「点画面暂停 / 双击全屏 / 右键菜单 / 滚轮 seek / OSC 进度条拖拽」互不打架：

| 手势 | 行为 |
|------|------|
| 左键**横向**拖 | 快进 / 后退（拖动时预览 OSC 进度 + 毛玻璃浮层显示目标时间，**松手才精确提交** `player.seek`，避免解码管线重启卡成幻灯片） |
| 左键**纵向（左半屏）**拖 | 调**音量**（实时 `setProperty`，即时反馈） |
| 左键**纵向（右半屏）**拖 | 调**亮度**（实时 `setProperty`） |

关键设计：
- **12px 阈值**区分点击与拖拽；越过阈值即取消待执行的「点击暂停」，所以"轻点暂停、按住拖拽"两种语义共存。
- **仅左键**发起手势，右键完整保留给上下文菜单，规避手势/菜单冲突。
- 音量/亮度手势期间 OSC 实时重绘；seek 手势期间抑制 OSC 重绘（复用 OSC 的 `dragging` 标志）。
- 新增开关 `mouse-gesture`（默认 true），设置面板「界面」可关；拖动时有专用毛玻璃浮层 `#gesture-overlay` + `body.gesture-active` 禁止文本选区。

## 改动文件（6 个，+200/−2）
- `src/main/config.js` — 新增 `mouse-gesture` 开关（入 BOOL_KEYS + 配置模板注释）
- `src/renderer/input.js` — 在 `bindInput` 内嵌手势逻辑（共享 `clickTimer`/`osc` 代理，导入 `fmtTime`）
- `src/renderer/app.js` — 给 input CTX 注入 `getConfig`（读开关）
- `src/renderer/panels/settings.js` — 「界面」分区加鼠标手势开关
- `src/renderer/index.html` — 加 `#gesture-overlay` 浮层 DOM
- `src/renderer/style.css` — 毛玻璃卡片样式（accent 渐变进度条）+ 淡入缩放动画 + 防选区

## 质量门禁
- 语法：改动 4 个 JS 文件 `node --check` 全 OK（全套 check-syntax 因 spawn 风暴被沙箱收割，逐文件已验证）
- 单测：**31/31** 通过
- 类型检查（tsc）：**clean**
- 冒烟：**22/22** 通过（关闭沙箱跑通；其中"音量属性可写 85""色彩均衡可写"正好覆盖手势用到的 `setProperty` 路径）

## 下一步
第四块（大块、产品成熟期再做）：**网络串流 / 投屏（DLNA/Chromecast）**。

## 备注
- 沙箱限制：`npm run test:smoke` 默认被沙箱进程组收割，需 `dangerouslyDisableSandbox=true` 才跑通——Exit 1 是拆卸假红，非测试失败。
- 冒烟遗留 2 个 `electron.exe`（PID 21380/13660）属**用户桌面真实播放器**，不在本沙箱令牌内，未动。
