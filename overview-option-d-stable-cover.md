# 选项 D：播放器默认样式改为「大封面居中」（封面位置稳定）

## 背景
用户反馈：空闲（idle）时 UI 布局正常，但**一播放音乐**，音乐舞台就跳到「歌词优先」布局（封面左移、右侧歌词），位置大变，体验割裂。

用户明确选择 **选项 D**：**不管播放音乐还是没音乐播放，封面位置都不能变动**。

## 根因
原 `default` 样式是**两栏布局**（封面在左 / 信息 + 歌词在右）。播放时会切换到歌词优先布局，导致：
- idle 态显示占位音符（`.ms-note`），位置在左栏；
- playing 态显示真实封面（`.ms-cover`），位置漂移。

封面在 idle 与 playing 之间位置不一致，造成「一播放就跳」的观感。

## 改动（选项 D）
把 `default` 样式改为**居中纵向布局**——大封面在上、信息在下居中，**不显示歌词与 credits**，从而让 idle（占位音符）与 playing（真实封面）天然停在**同一位置**。

| 文件 | 改动 |
|------|------|
| `src/renderer/style.css` | 重写 `#music-stage.style-default` 为 `flex-direction: column` 居中布局；`.ms-art` 宽 `min(360px,56vh,80vw)`；`.ms-right` 加 `min-height:120px`（让 idle 无信息 / playing 有信息时封面不跳）；隐藏 `.ms-lyrics-wrap` 与 `.ms-lyrics-credits` |
| `src/renderer/index.html` | 样式菜单项 `默认双栏` → `大封面` |
| `src/renderer/ui/music-stage.js` | `initMusicStage()` 增加一次性迁移：localStorage 存 `'lyrics'` 时重置为 `'default'`，再 `_applyPlayerStyle` |
| 注释 | `default=大封面居中(选项 D：播放/不播放封面位置一致，不显示歌词)` |

## 验证（全部通过）
- lint:syntax 143/0
- lint:imports OK
- test:unit 111/111
- typecheck 0
- pre-commit 4/4 ✓

## 提交与推送
- commit `adc62c3` style(music): default style = stable centered big cover (option D) — style.css + index.html
- commit `86bf1d0` fix(music): reset saved 'lyrics' player style to stable big-cover default — music-stage.js
- `github.com:443` 不通，走 Contents API 兜底推送：style.css `9c5a8e9`、index.html `c07be51`、music-stage.js `e368c9e`

## 用户须知
1. **彻底杀旧进程**（含托盘图标，单实例锁！）后再重启，否则旧窗口/锁会干扰。
2. 默认样式现在为「大封面居中 + 信息在下」，**不显示歌词**；无论播放与否封面位置一致。
3. 之前若选过「歌词」样式，本次会**一次性重置回大封面**，保证不乱跳。
4. 其余 3 个样式（封面 / 歌词 / 极简）仍正常可用，可随时切换。

## 待办（仍 OPEN）
- 更早的「你能复刻这些样式吗？」：用户发过 4 张 QQ 音乐皮肤风格图（经典黑胶 / 简约方形 / 透明彩胶 / 简约歌词），问能否复刻。已给难度表并追问澄清（做哪些 / 替换还是新增 / 旋转 / 配色来源 / 锁定机制），但用户先转向选项 D。若回头要做，按上述澄清问题继续。
