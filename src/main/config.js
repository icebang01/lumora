'use strict';
/**
 * 配置系统。
 *
 * 语法刻意与 mpv 保持一致，让 mpv 用户的配置习惯能直接迁移：
 *   player.conf  → key=value（等价 mpv.conf）
 *   input.conf   → <键> <命令> [参数...]
 *
 * 配置目录优先级：
 *   1. 命令行 --config-dir=
 *   2. 可执行文件同级的 portable_config/（便携模式）
 *   3. 系统用户数据目录
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_KEYBINDS } = require('../shared/default-keybinds');

/** 播放器默认配置。每一项都对应渲染管线或 UI 的一个真实行为。 */
const DEFAULTS = {
  // ---- 渲染 ----
  'scaler': 'ewa_lanczos',        // bilinear | bicubic | spline36 | ewa_lanczos
  'deband': false,
  'deband-strength': 0.35,
  'tone-mapping': 'bt2390',       // hable | mobius | reinhard | bt2390 | clip
  'target-peak': 203,             // 目标显示器峰值亮度 (nits)，SDR 参考白
  'dither': true,                 // 输出前抖动，消除 8bit 量化色带
  'correct-downscaling': true,
  'display-gamut': 'auto',        // 显示色彩管理：auto(读显示器EDID) | srgb | display-p3 | adobe-rgb | bt2020
  'video-sync': 'audio',          // audio | display

  // ---- 播放 ----
  'volume': 100,
  'mute': false,
  'speed': 1.0,
  'loop-file': 'no',              // no | inf | <次数>
  'keep-open': true,              // 播完停在最后一帧而不是退出
  'save-position-on-quit': true,
  'return-home-on-eof': true,     // 播完且无后续时自动返回 logo 落地页
  'history-count': 5,             // idle 屏"最近播放"最多保留/展示的条数（1~50，设置面板可调）
  'auto-add-siblings': true,      // 拖入单个文件时，自动把同目录其他媒体也加进播放列表
  'hwdec': 'auto',                // auto | no | <具体解码器>
  'video-sync': 'audio',          // audio | display（音画同步基准）
  'audio-delay': 0,               // 音画同步偏移 (ms)，正=音频延后
  'sub-delay': 0,                 // 字幕同步偏移 (ms)，正=字幕延后

  // ---- 界面 ----
  'theme': 'system',              // system | dark | light（独立窗口外观；播放覆盖层始终暗色防眩光）
  'ui-mode': 'auto',             // auto | music | video（auto=纯音频自动进音乐；music/video=全局强制）

  // ---- 音乐模式 ----
  'music.lyrics-auto-download': true, // 纯音频播放时若无本地 .lrc，自动从 LRCLIB 搜索下载同步歌词
  'music.lyrics-simplified': true,    // 下载/读取歌词时把繁体中文转为简体（opencc-js）
  'music.lyrics-include-credits': true, // 下载歌词时自动用 MusicBrainz/网易云补全词/曲/编曲等到 LRC 头部，让所有歌都有制作信息
  'music.lyrics-musixmatch-token': '',// Musixmatch 用户 token：填了则优先下载「逐字」歌词（唱到哪个字就哪个字着色）；留空则回退 LRCLIB 行级
  'music.lyrics-font-family': '',     // 播放器内歌词字体（留空使用界面默认）
  'music.lyrics-font-weight': 600,    // 播放器内歌词字重（100~900）
  'music.crossfade': false,           // 音乐接歌：真·重叠淡入淡出（下一曲音频头与当前曲尾同时混音）
  'music.crossfade-duration': 4,      // 交叉淡入淡出斜坡时长（秒）0~12
  'osc': true,
  'osc-timeout': 2000,            // 鼠标静止后控制条淡出延迟 (ms)
  'osd-duration': 1800,
  'osd-level': 1,
  'show-quality-badges': true,    // 是否显示 4K/8K/HDR/Dolby 等质量徽标
  'border': false,                // 无边框窗口 —— mpv 的标志性外观
  'ontop': false,
  'fullscreen': false,
  'autofit': '70%',               // 首次打开时窗口占屏幕比例
  'cursor-autohide': 1000,
  'mouse-gesture': true,          // 拖拽画面手势：横=快进/退，纵(左)=音量，纵(右)=亮度

  // ---- 画面均衡 ----
  'brightness': 0,                // -100 ~ 100
  'contrast': 0,
  'saturation': 0,
  'gamma': 0,
  'hue': 0,
  'interpolation': false,        // 运动插值（smoothmotion），需 mpv 支持

  // ---- 缓冲 ----
  'frame-queue-size': 12,         // 渲染端视频帧队列上限
  'audio-buffer': 0.2,            // 音频环形缓冲秒数

  // ---- 流控水位（需求驱动背压的迟滞阈值，秒）----
  // 音频缓冲 > flow-high-seconds 停喂，< flow-low-seconds 恢复；
  // 视频队列填满类似。集中到配置，方便低端机/高码率片调参。
  'flow-high-seconds': 2.0,       // 缓冲高于此值 → 告诉上游停喂
  'flow-low-seconds': 1.0,        // 缓冲低于此值 → 恢复喂数据

  // ---- 音频 ----
  'audio-exclusive': false,        // 独占模式（bit-perfect），需重启生效
  'alang': '',                     // 首选音频语言（如 jpn, eng），需重启生效

  // ---- 字幕 ----
  'sub-font-size': 55,             // 字号（mpv 默认 55）
  'sub-auto': 'fuzzy',             // mpv 合法值：no | exact | fuzzy | all（UI 旧值 auto/disabled 由 mpv-backend 归一化）
  'slang': 'chi,zho,zh,cmn',       // 首选字幕语言，逗号分隔；中文常用 chi/zho/zh/cmn

  // ---- 字幕外观（两个引擎共用一套配置；ffmpeg 走渲染端覆盖层，mpv 转成 --sub-*）----
  'sub-font-family': '',           // 字体（留空=系统默认无衬线，CJK 走系统回退）
  'sub-color': '#FFFFFF',          // 字幕颜色（#RRGGBB）
  'sub-bold': false,               // 粗体
  'sub-outline-size': 2,           // 描边粗细（px）
  'sub-outline-color': '#000000',  // 描边颜色
  'sub-shadow-size': 2,            // 阴影大小（px，0=无阴影）
  'sub-bg': false,                 // 字幕底衬（提升对比度）
  'sub-bg-color': '#000000',       // 底衬颜色
  'sub-bg-opacity': 50,            // 底衬不透明度 0-100
  'sub-pos': 88,                   // 垂直位置 0=顶部 100=底部（距底部百分比）
  'sub-codepage': '',              // 外挂字幕编码（留空=自动；中文 GBK 可填 cp936）

  // ---- 在线字幕（OpenSubtitles v1）----
  // 免费注册后在个人设置里拿一个 API Key；下载字幕还需登录用户名/密码。
  'opensubtitles-key': '',
  'opensubtitles-user': '',
  'opensubtitles-pass': '',
  // 载入视频时自动按文件名匹配中文（及首选语言）字幕并加载；
  // 无需凭据也会尝试射手网 / 字幕库 / SubHD 等无配置源。
  'subtitles-autoload': false,
  // 字幕代理（OpenSubtitles 兼容聚合器）：填了之后搜索同时查官方与代理，结果更多
  'subtitles-proxy-url': '',

  // ---- 弹幕（弹弹play / B 站 / 可自托管代理）----
  // 弹弹play 开放弹幕网络：开发者中心免费申请 AppId / AppSecret，用于文件名/hash 精准匹配
  'dandanplay-id': '',
  'dandanplay-secret': '',
  // danmu_api 代理（cirnot9，可自托管）：兼容弹弹接口，聚合 爱优腾芒哔人韩巴 + 弹弹
  'danmaku-proxy-url': '',
  // B 站 Cookie（可选）：提升弹幕接口配额，留空也能用
  'bilibili-cookie': '',
  // 载入视频时自动按文件名匹配弹幕并加载（B站零配置兜底，无需任何凭据；配了弹弹 AppId 或聚合代理时优先精准源）
  'danmaku-autoload': true,
  // 弹幕显示参数（面板调节后持久化，跨会话保留）
  'danmaku-opacity': 100,        // 不透明度 %，20~100
  'danmaku-fontsize': 28,        // 字号 px，16~56
  'danmaku-area': 100,           // 显示区域占屏高 %，25~100
  'danmaku-speed': 100,          // 滚动速度 %，50~200
  'danmaku-density': 200,        // 同屏最大条数，20~400
  'danmaku-enabled': true,       // 默认开启弹幕显示

  // ---- 引擎 ----
  'engine': 'mediafoundation',     // mpv | ffmpeg | mediafoundation（路线 A：Windows Media Foundation，去 GPL）
  'file-association': false,      // 双击媒体文件用 Lumora 打开（写 HKCU 注册表）

  // ---- 路径 ----
  'ffmpeg-dir': '',
  'screenshot-dir': '',
  'screenshot-format': 'png',
  'screenshot-template': 'lumora-%F-%P',

  // ---- 连拍（序列截图）----
  'screenshot-sequence-count': 5,      // 连拍张数
  'screenshot-sequence-interval': 500, // 连拍间隔 (ms)

  // ---- IPC ----
  'input-ipc-server': '',         // 非空则开启 JSON IPC
  'scripts': true,                // 是否自动加载 scripts/ 目录

  // ---- AI 助手（OpenAI 兼容后端）----
  // 未填 ai-api-key 时自动走内置离线桩（按关键词路由工具，不联网）；
  // 填了则调用 AI-backend 兼容接口（GPT / DeepSeek / 通义 / 智谱 等）。
  'ai-api-key': '',
  'ai-base-url': 'https://api.openai.com/v1',
  'ai-model': 'gpt-4o-mini',

  // Chromecast 鉴权（标准 Cast 客户端证书/私钥/salt，需用户自备；Lumora 不内置任何证书）。
  // 填 .pem 文件路径或粘贴 PEM 文本均可；缺失则 Chromecast 无法过 TLS 鉴权（DLNA 不受影响）。
  'cast.chromecastCert': '',
  'cast.chromecastKey': '',
  'cast.chromecastSalt': '',
};

/** 布尔字段：接受 yes/no/true/false/1/0，向 mpv 的写法看齐 */
const BOOL_KEYS = new Set([
  'deband', 'dither', 'correct-downscaling', 'mute', 'keep-open',
  'save-position-on-quit', 'osc', 'border', 'ontop', 'fullscreen', 'scripts',
  'file-association', 'show-quality-badges', 'audio-exclusive', 'interpolation',
  'return-home-on-eof', 'mouse-gesture', 'sub-bold', 'sub-bg',
  'auto-add-siblings', 'music.lyrics-auto-download', 'music.lyrics-simplified',
  'music.lyrics-musixmatch-token',
  'music.crossfade',
]);

const NUM_KEYS = new Set([
  'deband-strength', 'target-peak', 'volume', 'speed', 'osc-timeout',
  'osd-duration', 'osd-level', 'cursor-autohide', 'brightness', 'contrast',
  'saturation', 'gamma', 'hue', 'frame-queue-size', 'audio-buffer',
  'audio-delay', 'sub-delay', 'sub-font-size', 'sub-outline-size', 'sub-shadow-size', 'sub-bg-opacity', 'sub-pos',
  'flow-high-seconds', 'flow-low-seconds',
  'screenshot-sequence-count', 'screenshot-sequence-interval',
  'history-count', 'music.crossfade-duration', 'music.lyrics-font-weight',
]);

function parseBool(v) {
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' || s === 'on' || s === '';
}

function coerce(key, value) {
  if (BOOL_KEYS.has(key)) return parseBool(value);
  if (NUM_KEYS.has(key)) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * 解析 mpv.conf 风格的 key=value 文本。
 * 支持：注释、无值开关（等价 yes）、no- 前缀取反、引号包裹的值。
 */
function parseConfText(text) {
  const out = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    // 行尾注释，但要避开引号内的 #
    if (!line.includes('"') && !line.includes("'")) {
      const hash = line.indexOf(' #');
      if (hash > 0) line = line.slice(0, hash).trim();
    }

    const eq = line.indexOf('=');
    let key, value;
    if (eq === -1) {
      key = line;
      value = 'yes';
    } else {
      key = line.slice(0, eq).trim();
      value = line.slice(eq + 1).trim();
    }

    key = key.replace(/^--/, '');
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // mpv 的 no-xxx 写法等价于 xxx=no
    if (key.startsWith('no-') && eq === -1) {
      out[key.slice(3)] = false;
      continue;
    }
    out[key] = coerce(key, value);
  }
  return out;
}

/**
 * 解析 input.conf。
 * 每行：<键序列> <命令> [参数...]
 * 参数中的引号会被正确处理，方便传含空格的字符串。
 */
function parseInputConf(text) {
  const binds = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    // 切出第一个空白之前的键定义
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (!rest) continue;

    // 按空白切分，但保留引号内整体
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let t;
    while ((t = re.exec(rest)) !== null) {
      tokens.push(t[1] !== undefined ? t[1] : t[2] !== undefined ? t[2] : t[3]);
    }
    if (!tokens.length) continue;

    binds.push({ key, command: tokens[0], args: tokens.slice(1), raw: line });
  }
  return binds;
}

/**
 * 解析命令行参数。支持 --key=value / --key / --no-key / 位置参数(文件路径)。
 */
function parseArgv(argv) {
  const options = {};
  const files = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq === -1) {
        if (body.startsWith('no-')) options[body.slice(3)] = false;
        else options[body] = true;
      } else {
        const k = body.slice(0, eq);
        options[k] = coerce(k, body.slice(eq + 1));
      }
    } else if (!arg.startsWith('-')) {
      files.push(arg);
    }
  }
  return { options, files };
}

class Config {
  constructor(configDir) {
    this.dir = configDir;
    this.values = { ...DEFAULTS };
    this.keybinds = [];
    this.cliOverrides = {};
  }

  get playerConfPath() { return path.join(this.dir, 'player.conf'); }
  get inputConfPath() { return path.join(this.dir, 'input.conf'); }
  get scriptsDir() { return path.join(this.dir, 'scripts'); }
  get watchLaterDir() { return path.join(this.dir, 'watch_later'); }

  /** 首次运行时铺一份带注释的模板，用户不用对着文档从零写 */
  ensureScaffold() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.scriptsDir, { recursive: true });
    fs.mkdirSync(this.watchLaterDir, { recursive: true });

    if (!fs.existsSync(this.playerConfPath)) {
      fs.writeFileSync(this.playerConfPath, buildPlayerConfTemplate(), 'utf8');
    }
    if (!fs.existsSync(this.inputConfPath)) {
      fs.writeFileSync(this.inputConfPath,
        '# 在此覆盖默认键位。语法与 mpv input.conf 相同。\n' +
        '# 例：把 s 改成截图并保存到桌面\n' +
        '#   s screenshot\n\n', 'utf8');
    }
  }

  load() {
    // 1) 默认值 → 2) player.conf → 3) 命令行（优先级递增）
    this.values = { ...DEFAULTS };

    if (fs.existsSync(this.playerConfPath)) {
      try {
        const text = fs.readFileSync(this.playerConfPath, 'utf8');
        Object.assign(this.values, parseConfText(text));
      } catch (e) {
        console.error('[config] player.conf 解析失败:', e.message);
      }
    }
    Object.assign(this.values, this.cliOverrides);

    // 键位：默认表打底，用户配置覆盖同键
    const base = parseInputConf(DEFAULT_KEYBINDS);
    let user = [];
    if (fs.existsSync(this.inputConfPath)) {
      try {
        user = parseInputConf(fs.readFileSync(this.inputConfPath, 'utf8'));
      } catch (e) {
        console.error('[config] input.conf 解析失败:', e.message);
      }
    }
    const map = new Map();
    for (const b of base) map.set(b.key, b);
    for (const b of user) {
      // ignore 表示显式解绑该键
      if (b.command === 'ignore') map.delete(b.key);
      else map.set(b.key, b);
    }
    this.keybinds = [...map.values()];

    return this;
  }

  applyCli(options) {
    this.cliOverrides = options;
    Object.assign(this.values, options);
  }

  get(key) { return this.values[key]; }
  set(key, value) { this.values[key] = coerce(key, value); return this.values[key]; }

  toJSON() {
    return { values: this.values, keybinds: this.keybinds, dir: this.dir };
  }
}

function buildPlayerConfTemplate() {
  return `# ============================================================
# Lumora 播放器配置（语法与 mpv.conf 一致）
# 改完保存即可，无需重启 —— 播放器会热重载
# ============================================================

# ---------- 渲染管线 ----------
# 缩放算法：bilinear(最快) | bicubic | spline36 | ewa_lanczos(最锐利)
scaler=ewa_lanczos

# 去带：消除低码率视频在渐变区域的色阶断层
deband=no
deband-strength=0.35

# HDR 色调映射：hable | mobius | reinhard | bt2390(推荐) | clip
tone-mapping=bt2390
# 你的显示器峰值亮度(nits)。SDR 屏填 203，HDR 屏按实际标称填
target-peak=203

# 输出抖动，抹掉 8bit 面板上的量化色带
dither=yes

# 显示色彩管理：把视频从规范 sRGB/BT.709 换算到显示器实际色域，
# 修正广色域屏(sRGB 内容当成 sRGB 投进更宽色域)的过饱和。
# auto=启动时读取显示器 EDID 实测色域(失败回退 sRGB)；也可手动指定：
# srgb | display-p3 | adobe-rgb | bt2020
display-gamut=auto

# ---------- 播放行为 ----------
volume=100
speed=1.0
keep-open=yes
save-position-on-quit=yes
# 硬件解码：auto | no | dxva2 | d3d11va | cuda | vaapi | videotoolbox
hwdec=auto

# idle 屏"最近播放"最多保留/展示几条（1~50，设置面板也能调）
history-count=5

# 拖入单个媒体文件时，自动把同目录其他媒体也加进播放列表（yes/no）
auto-add-siblings=yes

# ---------- 窗口与界面 ----------
# 无边框 —— mpv 的标志性外观
border=no
osc=yes
osc-timeout=2000
osd-duration=1800
autofit=70%
cursor-autohide=1000
# 鼠标手势：在画面上按住拖动 —— 横向=快进/后退，纵向(左半屏)=音量，纵向(右半屏)=亮度
mouse-gesture=yes

# ---------- 画面均衡（-100 ~ 100）----------
brightness=0
contrast=0
saturation=0
gamma=0

# ---------- 缓冲 ----------
frame-queue-size=12
audio-buffer=0.2

# ---------- 流控水位（需求驱动背压的迟滞阈值，秒）----------
# 音频缓冲高于 flow-high-seconds 时通知上游停喂，低于 flow-low-seconds 时恢复；
# 视频队列同理。低端机或高码率片子可适当调大，减少卡顿。
flow-high-seconds=2.0
flow-low-seconds=1.0

# ---------- 引擎 ----------
# 播放后端：
#   mediafoundation —— 默认，系统解码器彻底去 GPL（Windows Media Foundation）
#   mpv      —— 进程内 GPU 解码，最稳，支持 8K
#   ffmpeg   —— 内置 LGPL 解码管线：ffmpeg 子进程解码 → WebSocket → 渲染端 WebGL2，
#              解码覆盖≈mpv（同底 libavcodec），且不含 GPL 二进制；分辨率上限 1080p
engine=mediafoundation
# 关联到系统文件类型：双击 mp4/mkv 等用 Lumora 打开（写入当前用户注册表，无需管理员）
file-association=no

# ---------- 外部集成 ----------
# 填入路径后可用 JSON IPC 遥控播放器
# Windows 示例: input-ipc-server=\\\\.\\pipe\\lumen-socket
# Unix   示例: input-ipc-server=/tmp/lumen-socket
input-ipc-server=

# 自动加载配置目录下 scripts/*.js
scripts=yes

# FFmpeg 所在目录（留空则自动从 PATH 查找）
ffmpeg-dir=

# ---------- 字幕 ----------
# 自动加载外挂字幕：no(关闭) | exact(严格匹配) | fuzzy(模糊匹配) | all(全部)
sub-auto=fuzzy
# 首选字幕语言，逗号分隔；中文常用 chi,zho,zh,cmn
slang=chi,zho,zh,cmn

# ---- 字幕外观 ----
sub-font-family=
sub-color=#FFFFFF
sub-bold=no
sub-outline-size=2
sub-outline-color=#000000
sub-shadow-size=2
sub-bg=no
sub-bg-color=#000000
sub-bg-opacity=50
sub-pos=88
sub-codepage=

# ---------- 音乐模式 ----------
# 播放纯音频时，若同目录没有 .lrc 外挂歌词，自动从 LRCLIB 免费源搜索并下载同步歌词
music.lyrics-auto-download=yes
# 下载/读取歌词时，把繁体中文自动转为简体（依赖 opencc-js，纯 JS 无原生模块）
music.lyrics-simplified=yes
# 下载歌词时自动补全词/曲/编曲/制作人等到 LRC 头部，让所有歌的歌词都带制作信息（而非仅部分源自带）
music.lyrics-include-credits=yes
# 播放器内歌词字体（留空使用界面默认；多个字体用逗号分隔，如 "PingFang SC, Microsoft YaHei"）
music.lyrics-font-family=
# 播放器内歌词字重（100~900）
music.lyrics-font-weight=600
# 音乐接歌：真·重叠淡入淡出（下一曲音频头与当前曲尾同时混音，equal-power 斜坡）
music.crossfade=no
# 斜坡时长（秒）0~12；越大重叠越长、接缝越柔，过大会吞掉当前曲尾
music.crossfade-duration=4

# ---------- 在线字幕（OpenSubtitles / 射手网 / 字幕库 / SubHD）----------
# 去 opensubtitles.com 免费注册，在个人设置里创建一个 API Key 填这里。
# 下载字幕还需登录用的用户名/密码（与注册账号一致）。
# 注意：密码以明文存于 player.conf，请仅在私有机器上使用。
# 不填 OpenSubtitles 凭据时，仍可使用无配置源：射手网、字幕库、SubHD。
opensubtitles-key=
opensubtitles-user=
opensubtitles-pass=
# 载入视频时自动按文件名匹配首选语言（含中文）字幕并加载：yes | no
# 无需凭据也会尝试射手网 / 字幕库 / SubHD 等无配置源。
# 默认关闭，避免无谓消耗网络配额。
subtitles-autoload=no

# 字幕代理（OpenSubtitles 兼容聚合器，可选）：填了之后字幕搜索会同时查官方与代理，
# 结果更多、下载地址更丰富。留空则只用官方 OpenSubtitles。如 http://127.0.0.1:8080
subtitles-proxy-url=

# ---------- 弹幕（弹弹play / B 站 / 可自托管代理）----------
# 弹弹play 开放弹幕网络：去 dandanplay.net 开发者中心免费申请 AppId / AppSecret，
# 用于按文件名 + hash 精准匹配本地番剧的弹幕（本地播放器事实标准）。
# 注意：Secret 以明文存于 player.conf，请仅在私有机器上使用。
# 留空则跳过弹弹，仅按文件名猜关键词在 B 站兜底搜索。
dandanplay-id=
dandanplay-secret=
# danmu_api 代理（cirnot9，可自托管）：兼容弹弹接口规范，后端聚合
# 爱奇艺/优酷/腾讯/芒果/哔哩/人人/韩巴 + 弹弹，是"接所有能接的"的总开关。
# 填了之后弹弹接口全部走代理（含签名逻辑），无需再单独配 AppId/Secret。
danmaku-proxy-url=
# B 站 Cookie（可选）：提升 dm 接口配额，留空也能搜能看。从浏览器登录态复制。
bilibili-cookie=
# 载入视频时自动按文件名匹配弹幕并加载：yes | no（B站零配置兜底，无需任何凭据）
danmaku-autoload=yes
# 弹幕显示参数（面板调节后自动保存，跨会话保留）
danmaku-opacity=100
danmaku-fontsize=28
danmaku-area=100
danmaku-speed=100
danmaku-density=200
danmaku-enabled=yes
`;
}

module.exports = { Config, DEFAULTS, parseConfText, parseInputConf, parseArgv };
