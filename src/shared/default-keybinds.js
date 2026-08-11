'use strict';
/**
 * 默认键位表 —— 严格对齐 mpv 的肌肉记忆。
 *
 * 从 mpv 迁移过来的人不应该需要重新学任何东西：空格暂停、方向键
 * 五秒跳转、逗号句号逐帧、方括号调速、ijkl 那套统计与信息面板，
 * 全部保持一致。用户可以用 input.conf 覆盖其中任意一条。
 *
 * 格式与 mpv 的 input.conf 完全相同：<键> <命令> [参数...]
 */

const DEFAULT_KEYBINDS = `
# ============================================================
# Lumora 默认键位表（语法兼容 mpv input.conf）
# 用户配置放在 input.conf 中，同键位会覆盖这里的定义
# ============================================================

# ---------- 播放控制 ----------
SPACE          cycle pause
p              cycle pause
MBTN_LEFT      cycle pause
ENTER          cycle pause
MBTN_LEFT_DBL  cycle fullscreen

# ---------- 文件 ----------
Ctrl+o         open-file
Ctrl+O         open-file
Ctrl+u         open-network-stream
Ctrl+U         open-network-stream

# ---------- 时间跳转 ----------
RIGHT          seek  5
LEFT           seek -5
UP             seek  60
DOWN           seek -60
Shift+RIGHT    seek  1  exact
Shift+LEFT     seek -1  exact
Shift+UP       seek  10 exact
Shift+DOWN     seek -10 exact
WHEEL_UP       add volume  5
WHEEL_DOWN     add volume -5
PGUP           add chapter  1
PGDWN          add chapter -1
HOME           seek 0 absolute
END            seek 100 absolute-percent

# ---------- 逐帧 ----------
.              frame-step
,              frame-back-step

# ---------- 速度 ----------
[              multiply speed 0.9091
]              multiply speed 1.1
{              multiply speed 0.5
}              multiply speed 2.0
BACKSPACE      set speed 1.0

# ---------- 音量 ----------
9              add volume -2
0              add volume  2
/              add volume -2
*              add volume  2
m              cycle mute
# 注意：滚轮用于音量调节（±5/次），seek 请用方向键或拖动进度条。
# 音量也可用屏幕滑块或 9/0/*// 键。

# ---------- 窗口 ----------
f              cycle fullscreen
ESC            set fullscreen no
Alt+ENTER      cycle fullscreen
T              pip
Ctrl+T         cycle ontop
Alt+0          set window-scale 0.5
Alt+1          set window-scale 1.0
Alt+2          set window-scale 2.0

# ---------- 退出 ----------
q              quit
Q              quit-watch-later
Ctrl+w         quit

# ---------- 轨道 ----------
# 注意：行首的 # 是注释，绑定 # 键要写成 SHARP（与 mpv 一致）
SHARP          cycle audio
a              cycle audio
j              cycle sub
J              cycle sub down
v              cycle sub-visibility
_              cycle video

# ---------- 字幕同步（sub-delay 以毫秒为单位；100=±0.1s，1000=±1s）----------
z              add sub-delay  100
x              add sub-delay -100
Z              add sub-delay  1000
X              add sub-delay -1000

# ---------- OSD / 信息 ----------
o              show-progress
O              cycle osd-level
i              cycle stats
I              cycle stats
?              show-keymap
F1             show-keymap
\`              script-binding console

# ---------- 画面调整 ----------
1              add contrast   -1
2              add contrast    1
3              add brightness -1
4              add brightness  1
5              add gamma      -1
6              add gamma       1
7              add saturation -1
8              add saturation  1
Alt+BACKSPACE  reset-video-eq

# ---------- 缩放平移 ----------
Alt+RIGHT      add video-pan-x -0.02
Alt+LEFT       add video-pan-x  0.02
Alt+UP         add video-pan-y  0.02
Alt+DOWN       add video-pan-y -0.02
Alt+=          add video-zoom   0.1
Alt+-          add video-zoom  -0.1
Ctrl+0         reset-pan-zoom

# ---------- 旋转 ----------
Shift+R        cycle-values video-rotate 90 180 270 0

# ---------- 截图 ----------
s              screenshot
S              screenshot video
Ctrl+s         screenshot window
Alt+s          screenshot-sequence

# ---------- 主题 ----------
Alt+T          toggle-theme

# ---------- 循环 ----------
l              ab-loop
L              loop-mode-cycle

# ---------- 播放列表 ----------
>              playlist-next
<              playlist-prev
F8             show-playlist

# ---------- 渲染管线 ----------
Ctrl+h         cycle hwdec
Ctrl+d         cycle deband
Ctrl+i         cycle-values scaler bilinear bicubic spline36 ewa_lanczos
Ctrl+t         cycle-values tone-mapping hable mobius reinhard bt2390 clip
`.trim();

module.exports = { DEFAULT_KEYBINDS };
