# 轨道拆分三按钮 + 右侧竖排工具栏（第 23 轮）

## 做了什么
将底部 OSC 工具栏的轨道选择从「统一轨道面板」改为 **三个独立按钮**，并把四个工具图标从底部栏移出、改为 **播放器最右侧竖排工具栏**。

## 关键改动（6 文件，已提交 `0d11684`，已推送远端）

### 底部栏轨道分组
- `btn-video-track`（视频轨）、`btn-audio-track`（音轨）、`btn-subtitle`（字幕轨）各自独立，点击打开细分面板
- 弹幕保持独立工具栏按钮 `btn-danmaku`，不再嵌套进字幕菜单

### 每个轨道面板可加外置轨
- `_buildVideoTrackMenu` / `_buildAudioTrackMenu`：选择段（vid/aid）+ 「添加外置视频轨 / 音轨」
- `_buildSubtitleMenu`：恢复字幕轨选择段 + 「添加外置字幕」
- `_addExternalTrack(kind)`：文件选择对话框（按类型自定义扩展名筛选）→ `video-add / audio-add / sub-add <path> select` + OSD 反馈

### 右侧竖排工具栏 `#side-rail`
- `index.html` 新增 `<div id="side-rail">`：`btn-ai` / `btn-screenshot` / `btn-screenshot-seq` / `btn-bookmark`
- `style.css`：`position:fixed` 居中竖排，`ui-visible` 时淡入归位，`idle`/`no-osc` 隐藏；圆形毛玻璃按钮 hover 发光放大
- `input.js`：右键/滚轮 ignore 名单同步新增 `#side-rail` 与两个轨菜单

### 主进程支撑
- `ipc-player.js`：`player:open-dialog` 支持可选 `opts {title, filters, properties}`，默认行为不受影响
- `preload.js`：`openDialog` 透传 opts

## 门禁
- 4 个 JS 文件 `node --check` 全 OK
- grep 确认无遗留 `#tracks-menu` / `btnTracks` / `tracksMenu` 引用
- 单测 / typecheck 本轮无相关改动，未重跑

## 待用户真机验证
- 重启 Lumora 后查看：底部栏 `[视频轨][音轨][字幕轨] │ [弹幕] │ …` + 右侧竖排 `[AI][截图][连拍][书签]`
- 点击任一轨道按钮 → 验证「添加外置轨」对话框与加载效果
