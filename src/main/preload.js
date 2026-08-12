'use strict';
/**
 * 预加载脚本 —— 主进程与渲染进程之间唯一的受控接口。
 *
 * contextIsolation 开着，渲染进程拿不到 Node，只能通过这里暴露的
 * 白名单方法说话。裸流数据不走这条路（见 media-server.js）。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * 读取音频 worklet 源码，供渲染端构造 blob URL。
 *
 * dev 下渲染页是 file://，AudioWorklet.addModule(file://) 在不少
 * Chromium / Electron 版本里会被安全策略拒绝，导致音频彻底无声。
 * 由主进程（Node 环境）读源码、渲染端包成 blob URL 即可绕开该限制。
 */
function readAudioWorkletSource() {
  const candidates = [
    path.join(__dirname, '..', 'renderer', 'core', 'audio-worklet.js'),
    path.join(process.resourcesPath || '', 'app', 'renderer', 'core', 'audio-worklet.js'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch { /* 试下一个候选 */ }
  }
  return null;
}

/** 主进程 → 渲染进程 的事件白名单 */
const INBOUND = [
  'player:loading',
  'player:loaded',
  'player:subtitles',
  'player:danmaku',
  'player:error',
  'player:log',
  'player:pipeline-started',
  'player:degraded',
  'player:crossfade-started',
  'player:crossfade-ended',
  'osd',
  'window:state',
  'window:pip',
  'window:restored',
  'ipc:command',
  'mpv:property',
  'mpv:event',
  'app:open-file',
  'player:ai-event',
  'player:command',
  'cast:device',
  'cast:state',
  'updater:status',
  'updater:progress',
  'desktop-lyrics:data',
  'desktop-lyrics:state',
  'desktop-lyrics:font',
];

contextBridge.exposeInMainWorld('lumen', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  // ---- 播放 ----
  // opts 可选：{ title, filters, properties, source }（source 区分视频/音乐引擎）
  openDialog: (opts) => ipcRenderer.invoke('player:open-dialog', opts || {}),
  load: (p, opts) => ipcRenderer.invoke('player:load', p, opts),
  getCurrentInfo: () => ipcRenderer.invoke('player:get-current-info'),
  // source 末尾参数：'music' 走音乐（纯音频）引擎，缺省/其他走视频引擎
  seek: (t, source) => ipcRenderer.invoke('player:seek', t, source),
  setSpeed: (speed, currentTime, source) =>
    ipcRenderer.invoke('player:set-speed', { speed, currentTime }, source),
  setTrack: (type, index, currentTime, source) =>
    ipcRenderer.invoke('player:set-track', { type, index, currentTime }, source),
  setHwdec: (mode, currentTime, source) =>
    ipcRenderer.invoke('player:set-hwdec', { mode, currentTime }, source),
  // ffmpeg 引擎：请求主进程用 ffmpeg 把指定字幕轨 dump 成 SRT 并解析后发回
  setSubtitleTrack: (index) => ipcRenderer.invoke('player:set-subtitle-track', { index }),
  setSecondarySubtitleTrack: (index) => ipcRenderer.invoke('player:set-secondary-subtitle-track', { index }),

  // ---- 在线字幕（OpenSubtitles / 射手网 / 字幕库 / SubHD）----
  searchSubtitles: (opts) => ipcRenderer.invoke('subtitles:search', opts),
  autoMatchSubtitles: () => ipcRenderer.invoke('subtitles:auto-match'),
  downloadSubtitle: (opts) => ipcRenderer.invoke('subtitles:download', opts),
  loginSubtitles: () => ipcRenderer.invoke('subtitles:login'),

  // ---- 弹幕（弹弹play / B 站 / 代理）----
  searchDanmaku: (keyword) => ipcRenderer.invoke('danmaku:search', { keyword }),
  autoMatchDanmaku: () => ipcRenderer.invoke('danmaku:auto-match'),
  loadDanmaku: (source) => ipcRenderer.invoke('danmaku:load', { source }),
  countDanmaku: (source) => ipcRenderer.invoke('danmaku:count', { source }),

  stop: (source) => ipcRenderer.send('player:stop', source),
  reportTime: (t) => ipcRenderer.send('player:time-update', t),

  // ---- 交叉淡入淡出（真·重叠）----
  // 渲染端请求主进程生成并发副声部（解码下一曲目音频头）
  crossfadeStart: (info, reqId) => ipcRenderer.invoke('crossfade:start', info, reqId),
  // 渲染端请求终止副声部（seek/stop/被打断时）
  crossfadeCancel: () => ipcRenderer.invoke('crossfade:cancel'),
  // 渲染端完成提升：主进程把副声部管线交换为新的主声部管线
  crossfadeCommit: () => ipcRenderer.invoke('crossfade:commit'),

  // ---- 窗口 ----
  windowCommand: (action, value) => ipcRenderer.invoke('window:command', { action, value }),
  // （dragStart/dragEnd 已废弃：第二十八轮改为主进程用 move-storm 判定拖动，
  //  不依赖 will-move / 渲染端 mousedown——该环境二者均不可靠）
  setIdleState: (idle) => ipcRenderer.invoke('ui:set-idle-state', idle),
  togglePip: () => ipcRenderer.invoke('window:pip-toggle'),

  // ---- 音乐播放样式窗口位置记忆 ----
  // 渲染端在切换样式 / 进入·退出音乐模式时通知主进程，主进程据此
  // 记忆并恢复每个播放样式自己的窗口位置（x,y,width,height）。
  musicStyle: (style) => ipcRenderer.send('music:style', style),
  musicAudio: (v) => ipcRenderer.send('music:audio', v),
  // 从音乐模式返回主页：请求主进程保留当前窗口位置（不要重置为居中首页尺寸）
  musicReturnHome: () => ipcRenderer.send('music:return-home'),

  // ---- 截图 ----
  saveScreenshot: (dataUrl, timePos) =>
    ipcRenderer.invoke('player:save-screenshot', { dataUrl, timePos }),

  // ---- 配置 ----
  setConfig: (key, value) => ipcRenderer.invoke('config:set', { key, value }),
  saveConfig: (key, value) => ipcRenderer.invoke('config:save', { key, value }),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  reloadConfig: () => ipcRenderer.invoke('config:reload'),
  openConfigDir: () => ipcRenderer.invoke('config:open-dir'),

  // ---- 键位自定义 ----
  exportKeybinds: () => ipcRenderer.invoke('config:export-keymap'),
  getKeybinds: () => ipcRenderer.invoke('config:get-keymap'),
  saveKeybinds: (text) => ipcRenderer.invoke('config:save-keymap', { text }),

  // ---- 续播 ----
  getResume: () => ipcRenderer.invoke('app:get-resume'),
  clearResume: () => ipcRenderer.invoke('app:clear-resume'),

  // ---- 播放历史 ----
  getHistory: () => ipcRenderer.invoke('app:get-history'),
  clearHistory: () => ipcRenderer.invoke('app:clear-history'),
  removeHistory: (p) => ipcRenderer.invoke('app:remove-history', p),

  // ---- 缩略图 ----
  getThumbnail: (p) => ipcRenderer.invoke('app:thumbnail', p),
  getSeekSheet: (arg) => ipcRenderer.invoke('app:seek-sheet', arg),

  // ---- 媒体元数据（时长/分辨率），海报墙 badge 用 ----
  getMediaMeta: (arg) => ipcRenderer.invoke('app:get-media-meta', arg),

  // ---- 音频播放器增强：封面 + 歌词 ----
  getCoverArt: (p) => ipcRenderer.invoke('app:cover-art', p),
  getArtistPhoto: (artist) => ipcRenderer.invoke('app:artist-photo', { artist }),
  getLyrics: (p) => ipcRenderer.invoke('app:lyrics', p),
  downloadLyrics: (p, meta) => ipcRenderer.invoke('app:lyrics-download', { path: p, meta }),
  // 歌词自动偏移校准：ffmpeg 检测音频首句起音，返回应施加的偏移（秒）或 null
  lyricAutoOffset: (path, firstLineTime) => ipcRenderer.invoke('app:lyric-auto-offset', { path, firstLineTime }),
  translateLyrics: (lines, to) => ipcRenderer.invoke('app:lyrics-translate', { lines, to }),
  // 词曲编曲在线查询（MusicBrainz + 网易云音乐 fallback）
  getCredits: (title, artist) => ipcRenderer.invoke('app:credits', { title, artist }),

  loadPlaylist: () => ipcRenderer.invoke('playlist:load'),
  savePlaylist: (state) => ipcRenderer.invoke('playlist:save', state),

  // ---- 显示色彩管理（EDID 实测 / ICC 文件）----
  getDisplayProfile: () => ipcRenderer.invoke('system:display-profile'),
  openIcc: () => ipcRenderer.invoke('system:open-icc'),

  // ---- 脚本 ----
  listScripts: () => ipcRenderer.invoke('scripts:list'),

  // ---- 拖拽 ----
  // Electron 32+ 移除了 File.path，必须用 webUtils 才能拿到真实磁盘路径
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  dropped: (p) => ipcRenderer.invoke('player:dropped', p),
  scanSiblings: (p) => ipcRenderer.invoke('player:scan-siblings', p),
  // 拖放统一入口：把原始路径（文件 + 文件夹混合）交给主进程递归展开成媒体列表
  collectMedia: (paths) => ipcRenderer.invoke('player:collect-media', paths),

  // ---- mpv 直通 ----
  // 渲染端直接给 mpv 发命令和设属性，绕过主进程的业务逻辑
  // source 末尾参数：区分视频/音乐引擎
  mpvCommand: (args, source) => ipcRenderer.invoke('mpv:command', args, source),
  mpvSetProperty: (name, value, source) =>
    ipcRenderer.invoke('mpv:set-property', { name, value }, source),
  mpvScreenshot: (mode, source) => ipcRenderer.invoke('mpv:screenshot', mode, source),

  // ---- AI 助手 ----
  aiChat: (text) => ipcRenderer.invoke('player:ai:chat', { text }),
  aiReset: () => ipcRenderer.invoke('player:ai:reset'),
  aiStatus: () => ipcRenderer.invoke('player:ai:status'),
  aiReload: () => ipcRenderer.invoke('player:ai:reload'),
  aiFetchModels: () => ipcRenderer.invoke('player:ai:fetch-models'),

  // ---- 投屏（DLNA cast-out）----
  castStartDiscovery: () => ipcRenderer.invoke('cast:start-discovery'),
  castStopDiscovery: () => ipcRenderer.invoke('cast:stop-discovery'),
  castList: () => ipcRenderer.invoke('cast:list'),
  castConnect: (udn) => ipcRenderer.invoke('cast:connect', { udn }),
  castPlayFile: (path, opts) => ipcRenderer.invoke('cast:play-file', { path, ...(opts || {}) }),
  castPlayUrl: (url, opts) => ipcRenderer.invoke('cast:play-url', { url, ...(opts || {}) }),
  castPause: () => ipcRenderer.invoke('cast:pause'),
  castResume: () => ipcRenderer.invoke('cast:resume'),
  castStop: () => ipcRenderer.invoke('cast:stop'),
  castSeek: (seconds) => ipcRenderer.invoke('cast:seek', { seconds }),
  castSetVolume: (volume) => ipcRenderer.invoke('cast:set-volume', { volume }),
  castDisconnect: () => ipcRenderer.invoke('cast:disconnect'),
  castGetState: () => ipcRenderer.invoke('cast:get-state'),

  // ---- 自动更新 ----
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdateState: () => ipcRenderer.invoke('updater:get-state'),

  // ---- 桌面歌词（独立置顶悬浮窗）----
  // 主渲染进程 → 主进程：当前歌词行（仅行切换时低频推送）
  desktopLyricsUpdate: (payload) => ipcRenderer.send('desktop-lyrics:update', payload),
  // 主渲染进程 → 主进程：开关/显隐（需返回可见状态以更新按钮 aria）
  desktopLyricsToggle: () => ipcRenderer.invoke('desktop-lyrics:toggle'),
  desktopLyricsShow: () => ipcRenderer.invoke('desktop-lyrics:show'),
  desktopLyricsHide: () => ipcRenderer.invoke('desktop-lyrics:hide'),
  // 歌词窗口 → 主进程：拖拽位移 / 字号调整 / 关闭
  desktopLyricsMove: (dx, dy) => ipcRenderer.send('desktop-lyrics:move', { dx, dy }),
  desktopLyricsFontSize: (delta) => ipcRenderer.send('desktop-lyrics:fontsize', { delta }),
  desktopLyricsFontFamily: (family) => ipcRenderer.send('desktop-lyrics:font-family', { family }),
  desktopLyricsFontWeight: (weight) => ipcRenderer.send('desktop-lyrics:font-weight', { weight }),
  desktopLyricsClose: () => ipcRenderer.send('desktop-lyrics:close'),

  // ---- 事件 ----
  on: (channel, cb) => {
    if (!INBOUND.includes(channel)) {
      throw new Error(`channel not allowed: ${channel}`);
    }
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  emitIpcEvent: (payload) => ipcRenderer.send('ipc:event', payload),

  // ---- 音频 worklet 源码（渲染端据此构造 blob URL，绕开 file:// 限制）----
  getAudioWorkletSource: () => readAudioWorkletSource(),
});
