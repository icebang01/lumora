# 复刻 QQ 音乐 4 款播放页皮肤

把用户早先发的 4 张 QQ 音乐皮肤样式，复刻为 Lumora 音乐播放器的「播放器样式」选项，接入现有 `#music-stage.style-{key}` 切换系统。

## 新增样式键（共 8 项）

| 键 | 名称 | 视觉特征 |
|----|------|----------|
| `vinyl` | 经典黑胶 | 封面居中圆形标签，外圈黑胶盘体（同心纹路 + 中心轴孔）；**有封面且播放时整体旋转** |
| `square` | 简约方形 | 方形封面（圆角 12px）+ 浅色卡片底 + 大留白，不显示歌词 |
| `glass` | 透明彩胶 | 同黑胶结构，盘体取**专辑主色半透明 + 毛玻璃**（`color-mix` + `backdrop-filter`）；播放时旋转 |
| `lyrics-min` | 简约歌词 | 小封面缩略（~120px）+ 大段居中歌词，隐藏创作信息与专辑行，最精简 |

（原有 4 项：大封面 / 封面居中 / 歌词优先 / 极简 保留不变。）

## 实现要点
- **黑胶 / 彩胶圆盘**：`.ms-art` 改为 `overflow: visible; border-radius: 50%`；盘体用 `.ms-art::before`（同心 `repeating-radial-gradient` 纹路 + 径向渐变），轴孔用 `.ms-art::after`；封面 `.ms-cover` 设 `inset: 18%` 成居中圆形标签。
- **旋转**：`#music-stage.style-vinyl.playing .ms-art` / `style-glass.playing .ms-art` → `animation: ms-vinyl-spin 9s linear infinite`（仅播放中旋转）。
- **无障碍**：`prefers-reduced-motion: reduce` 下 `.ms-art { animation: none !important }` 已存在，旋转自动停止。
- **接入点**：`PLAYER_STYLES` 数组增加 4 键；`index.html` 样式菜单新增 4 个 `.mc-style-opt`；`_applyPlayerStyle` 用 `includes` 校验，无需改动。

## 改动文件
- `src/renderer/style.css` — 新增 4 个 `style-*` 块 + `ms-vinyl-spin` 关键帧 + 顶部注释
- `src/renderer/ui/music-stage.js` — `PLAYER_STYLES` 增加 `'vinyl','square','glass','lyrics-min'`
- `src/renderer/index.html` — 样式菜单新增 4 个选项

## 验证（全绿）
- lint:syntax 143/0
- lint:imports OK
- test:unit 111/111
- typecheck 0
- pre-commit 4/4 ✓

## 提交与推送
- commit `ad0732d`（3 files, +211 −3）
- `github.com:443` 不通，走 Contents API 兜底：style.css `c61ee58`、music-stage.js `27c3380`、index.html `4bbd937`

## 用户须知
1. **彻底杀旧进程**（含托盘，单实例锁！）后重启，新样式才生效。
2. 黑胶 / 彩胶**仅在有封面且播放中**才旋转；暂停即停。
3. 沙箱无 GPU，看不到实际画面，但代码已落地，本机可验证。
4. 想微调任一款（盘更大 / 标签更小 / 配色 / 方形更方 / 歌词更紧凑）告诉我即可。

## 后续可选
- 给黑胶 / 彩胶加「暂停时缓动减速停下」而非硬停。
- 让透明彩胶的色调源可在「专辑主色 / 固定渐变」间切换。
- 方形 / 简约歌词支持浅色主题（当前偏暗）。
