/**
 * IPC 注册·player（自包含模块）。
 * 从 register-ipc.js 拆出（2026-08）：播放控制域：player:*（载入/seek/速度/轨道/hwdec/停止）+ mpv 直通 + 截图。
 * 用法：register(ctx)——ctx 与 register-ipc.js 的 setCtx 同构（getConfig/getCurrentInfo/...），
 * 由 register-ipc.js 编排器统一注入。
 */
const { ipcMain, dialog, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadFile } = require('./play-control');
const { collectMediaFromSelection } = require('./file-assoc');
const { extractAndSendSubtitles } = require('./media-auto');
let CTX = {};
function register(ipcCtx) { CTX = ipcCtx || {};
function getWin() { return CTX.getWin ? CTX.getWin() : null; }
function getVideoWin() { return CTX.getVideoWin ? CTX.getVideoWin() : null; }
function getCurrentInfo() { return CTX.getCurrentInfo ? CTX.getCurrentInfo() : null; }
function getUseMpv() { return CTX.getUseMpv ? CTX.getUseMpv() : true; }
function getMpvBackend() { return CTX.getMpvBackend ? CTX.getMpvBackend() : null; }
function getBackend(source) { return CTX.getBackend ? CTX.getBackend(source) : null; }
function getPipeline() { return CTX.getPipeline ? CTX.getPipeline() : null; }
function setLastKnownTime(v) { if (CTX.setLastKnownTime) CTX.setLastKnownTime(v); }
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getLastKnownTime() { return CTX.getLastKnownTime ? CTX.getLastKnownTime() : 0; }
function formatTimeForFilename(t) { return CTX.formatTimeForFilename ? CTX.formatTimeForFilename(t) : String(t); }
function startCrossfade(info) { return CTX.startCrossfade ? CTX.startCrossfade(info) : null; }
function endCrossfade() { return CTX.endCrossfade ? CTX.endCrossfade() : null; }
function commitCrossfade() { return CTX.commitCrossfade ? CTX.commitCrossfade() : null; }



  ipcMain.handle('player:open-dialog', async (_e, opts) => {
    opts = opts || {};
    // 默认：打开媒体文件（支持多选/文件夹）；外置轨场景由渲染端传入自定义
    // filters / properties / title（例如只选单个字幕/音频/视频文件）。
    const title = opts.title || '打开媒体文件';
    const properties = opts.properties || ['openFile', 'multiSelections', 'openDirectory'];
    const filters = opts.filters || [
      { name: '媒体文件', extensions: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'ts', 'm2ts', 'wmv', 'mpg', 'mpeg', 'm4v', '3gp', 'ogv', 'mp3', 'flac', 'aac', 'wav', 'ogg', 'opus', 'm4a', 'wma'] },
      { name: '视频', extensions: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'ts', 'm2ts', 'wmv'] },
      { name: '音频', extensions: ['mp3', 'flac', 'aac', 'wav', 'ogg', 'opus', 'm4a'] },
      { name: '全部文件', extensions: ['*'] },
    ];
    const res = await dialog.showOpenDialog(getWin(), {
      title, properties, filters,
    });
    // Windows 透明无边框窗口在模态对话框关闭后经常不重绘，露出黑色背景。
    // webContents.invalidate() 强制 Chromium 重绘；1px 尺寸微动强制 DWM
    // 重新合成透明窗口层，两者配合可覆盖大多数情况。
    if (getWin() && !getWin().isDestroyed() && getVideoWin() && !getVideoWin().isDestroyed()) {
      // invalidate() 强制 Chromium 重绘透明 UI 层（主手段）；
      // 1px 尺寸微动作用在父窗口 videoWin 上——win 作为子窗口的越界会被裁剪，
      // 对父窗口微动可强制 DWM 重新合成透明子窗口层，覆盖透明窗口不重绘的黑底。
      getWin().webContents.invalidate();
      const b = getVideoWin().getBounds();
      getVideoWin().setBounds({ ...b, width: b.width + 1 });
      setImmediate(() => getVideoWin().setBounds(b));
    }
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    // 选了文件夹则列出其中所有媒体文件；仅选文件（外置轨场景）则原样返回
    const allowDir = properties.includes('openDirectory');
    const paths = allowDir ? collectMediaFromSelection(res.filePaths) : res.filePaths;
    return { ok: true, paths };
  });



  ipcMain.handle('player:load', (_e, filePath, opts) => loadFile(filePath, opts));



  /** 当前媒体是否为纯音频（音乐）。音乐始终走 ffmpeg 管线（music-player.js），
 * 即使 config.engine=mpv 也绝不路由到 mpv —— 路由错了就是 seek 后静音/停止失效。 */
function isCurrentMusic() {
  const info = getCurrentInfo();
  return !!(info && info.audioOnly);
}

ipcMain.handle('player:seek', (_e, time, source) => {
    if (!getCurrentInfo()) return { ok: false };
    // 纯音频（音乐）始终走 ffmpeg 管线；视频引擎在 mpv 可用时走 mpv
    if (!isCurrentMusic() && getUseMpv() && getMpvBackend() && getMpvBackend().ready) {
      getMpvBackend().seek(time).catch((e) => console.warn('[mpv] seek 失败:', e.message));
      setLastKnownTime(time);
      return { ok: true, epoch: 0, time };
    }
    if (!getPipeline()) return { ok: false };
    const epoch = getPipeline().seek(time);
    setLastKnownTime(time);
    return { ok: true, epoch, time };
  });



  ipcMain.handle('player:set-speed', (_e, { speed, currentTime }, source) => {
    if (!getCurrentInfo()) return { ok: false };
    if (!isCurrentMusic() && getUseMpv() && getMpvBackend() && getMpvBackend().ready) {
      getMpvBackend().setProperty('speed', speed).catch((e) => console.warn('[mpv] set speed 失败:', e.message));
      return { ok: true, epoch: 0, speed };
    }
    if (!getPipeline()) return { ok: false };
    const epoch = getPipeline().setSpeed(speed, currentTime);
    return { ok: true, epoch, speed: getPipeline().speed };
  });



  ipcMain.handle('player:set-track', (_e, { type, index, currentTime }, source) => {
    if (!getCurrentInfo()) return { ok: false };
    if (!isCurrentMusic() && getUseMpv() && getMpvBackend() && getMpvBackend().ready) {
      getMpvBackend().setTrack(type, index).catch((e) => console.warn('[mpv] set track 失败:', e.message));
      return { ok: true, epoch: 0, output: null };
    }
    if (!getPipeline()) return { ok: false };
    const epoch = type === 'video'
      ? getPipeline().setVideoTrack(index, currentTime)
      : getPipeline().setAudioTrack(index, currentTime);
    if (epoch === null) return { ok: false, error: '轨道不存在' };
    return { ok: true, epoch, output: getPipeline().videoOutput || null };
  });


  // ffmpeg 引擎的字幕轨切换：把字幕轨 dump 成 SRT 解析后发给渲染端。
  // mpv 引擎由 mpv 自身渲染，这里直接放行不处理。

  ipcMain.handle('player:set-subtitle-track', (_e, { index }) => {
    if (!getCurrentInfo()) return { ok: false };
    if (getUseMpv()) return { ok: true };
    extractAndSendSubtitles(index);
    return { ok: true };
  });

  // 第二字幕轨（双字幕）：与上一指令对称，仅多一个 secondary 标记
  ipcMain.handle('player:set-secondary-subtitle-track', (_e, { index }) => {
    if (!getCurrentInfo()) return { ok: false };
    if (getUseMpv()) return { ok: true };
    extractAndSendSubtitles(index, true);
    return { ok: true };
  });



  ipcMain.handle('player:set-hwdec', (_e, { mode, currentTime }, source) => {
    if (!isCurrentMusic() && getUseMpv() && getMpvBackend() && getMpvBackend().ready) {
      const mpvVal = mode === 'auto' ? 'auto-safe' : mode;
      getMpvBackend().setProperty('hwdec', mpvVal).catch((e) => console.warn('[mpv] set hwdec 失败:', e.message));
      getConfig().set('hwdec', mode);
      return { ok: true, mode };
    }
    if (getPipeline()) {
      getPipeline().hwaccel = mode;
      getConfig().set('hwdec', mode);
      if (!getCurrentInfo()) return { ok: true, mode };
      return { ok: true, mode, epoch: getPipeline().start(currentTime) };
    }
    return { ok: true, mode };
  });



  ipcMain.on('player:time-update', (_e, time) => { setLastKnownTime(time); });



  ipcMain.on('player:stop', (_e, source) => {
    if (!isCurrentMusic() && getUseMpv() && getMpvBackend() && getMpvBackend().ready) {
      getMpvBackend().stop().catch((e) => console.warn('[mpv] stop 失败:', e.message));
    } else if (getPipeline()) {
      getPipeline().stop();
    }
  });


  // ---- 交叉淡入淡出（真·重叠）----
  // 渲染端请求生成并发副声部（解码下一曲目音频头）；实际副声部就绪后
  // 由 media-pipeline 回发 player:crossfade-started 事件给渲染端。
  ipcMain.handle('crossfade:start', (_e, info, reqId) => {
    if (getUseMpv()) return { ok: false, error: 'mpv 引擎不支持 ffmpeg 交叉淡入淡出' };
    startCrossfade(info, reqId);
    return { ok: true };
  });
  // 渲染端请求终止副声部（seek/stop/被打断时）
  ipcMain.handle('crossfade:cancel', () => {
    endCrossfade();
    return { ok: true };
  });
  // 渲染端完成提升：把副声部管线交换为新的主声部管线
  ipcMain.handle('crossfade:commit', () => {
    commitCrossfade();
    return { ok: true };
  });


  // ---- mpv 直通命令 ----

  ipcMain.handle('mpv:command', (_e, args, source) => {
    const be = getBackend();
    if (be && be.ready) {
      return be.command(...args).catch((e) => ({ error: e.message }));
    }
    return { error: 'mpv 未就绪' };
  });



  ipcMain.handle('mpv:set-property', (_e, { name, value }, source) => {
    const be = getBackend();
    if (be && be.ready) {
      be.setProperty(name, value).catch((e) => {
        console.warn(`[mpv] 设置属性失败 ${name}:`, e.message);
      });
      return { ok: true };
    }
    return { ok: false };
  });


  // ---- 截图 ----
  // mpv 后端：直接让 mpv 把当前帧写到文件，不走 WebGL 回读

  ipcMain.handle('mpv:screenshot', async (_e, mode) => {
    try {
      const be = getMpvBackend();
      if (!be || !be.ready) {
        return { ok: false, error: 'mpv 未就绪' };
      }
      let dir = getConfig().get('screenshot-dir');
      if (!dir) dir = app.getPath('pictures');
      fs.mkdirSync(dir, { recursive: true });

      const base = getCurrentInfo() ? path.parse(getCurrentInfo().path).name : 'lumora';
      const stamp = formatTimeForFilename(getLastKnownTime());
      const fmt = getConfig().get('screenshot-format') === 'jpg' ? 'jpg' : 'png';
      let file = path.join(dir, `${base}-${stamp}.${fmt}`);
      let n = 1;
      while (fs.existsSync(file)) {
        file = path.join(dir, `${base}-${stamp}-${n++}.${fmt}`);
      }

      const mpvMode = mode === 'subtitles' ? 'subtitles' : 'video';
      await be.command('screenshot-to-file', file, mpvMode);
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });



  ipcMain.handle('player:save-screenshot', async (_e, { dataUrl, timePos }) => {
    try {
      let dir = getConfig().get('screenshot-dir');
      if (!dir) dir = app.getPath('pictures');
      fs.mkdirSync(dir, { recursive: true });

      const base = getCurrentInfo() ? path.parse(getCurrentInfo().path).name : 'lumora';
      const stamp = formatTimeForFilename(timePos);
      const fmt = getConfig().get('screenshot-format') === 'jpg' ? 'jpg' : 'png';
      let file = path.join(dir, `${base}-${stamp}.${fmt}`);
      let n = 1;
      while (fs.existsSync(file)) {
        file = path.join(dir, `${base}-${stamp}-${n++}.${fmt}`);
      }

      const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  // ---- 拖拽落文件 ----

  ipcMain.handle('player:dropped', (_e, filePath) => loadFile(filePath));

  // 拖入单个文件时，扫描同目录其他媒体，返回完整播放列表候选
  ipcMain.handle('player:scan-siblings', (_e, filePath) => {
    const { scanSiblings } = require('./file-assoc');
    try {
      return { ok: true, paths: scanSiblings(filePath) };
    } catch (err) {
      return { ok: false, error: err.message, paths: [filePath] };
    }
  });

  // 拖放统一入口：文件 + 文件夹混合路径 → 递归展开成媒体列表（含自然排序）
  ipcMain.handle('player:collect-media', (_e, paths) => {
    const { collectMediaFromSelection } = require('./file-assoc');
    try {
      const list = collectMediaFromSelection(Array.isArray(paths) ? paths : []);
      return { ok: true, paths: list };
    } catch (err) {
      return { ok: false, error: err.message, paths: Array.isArray(paths) ? paths : [] };
    }
  });

  // 查询当前播放文件元信息（供桌面歌词等场景在缓存丢失时兜底恢复）
  ipcMain.handle('player:get-current-info', () => {
    const info = getCurrentInfo();
    if (!info) return null;
    const { sanitizeInfo } = require('./pip');
    try { return sanitizeInfo(info); } catch { return null; }
  });
}

module.exports = { register };
