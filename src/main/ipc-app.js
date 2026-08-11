/**
 * IPC 注册·app（自包含模块）。
 * 从 register-ipc.js 拆出（2026-08）：应用配置域：app:bootstrap + config:*（含键位编辑）+ scripts:list。
 * 用法：register(ctx)——ctx 与 register-ipc.js 的 setCtx 同构（getConfig/getCurrentInfo/...），
 * 由 register-ipc.js 编排器统一注入。
 */
const { ipcMain, shell, app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { DEFAULTS, parseInputConf } = require('./config');
const { DEFAULT_KEYBINDS } = require('../shared/default-keybinds');
const { applyFileAssociation } = require('./file-assoc');
const { loadResume } = require('./resume-store');
const { loadPlaylist } = require('./playlist-store');
const Subtitles = require('./subtitles');
const Danmaku = require('./danmaku');
const { setHistoryLimit } = require('./history-store');
let CTX = {};
function register(ipcCtx) { CTX = ipcCtx || {};
function getConfig() { return CTX.getConfig ? CTX.getConfig() : null; }
function getMediaServer() { return CTX.getMediaServer ? CTX.getMediaServer() : null; }
function getFfmpegCaps() { return CTX.getFfmpegCaps ? CTX.getFfmpegCaps() : null; }
function getPendingOpenFile() { return CTX.getPendingOpenFile ? CTX.getPendingOpenFile() : null; }
function writePlayerConfKey(key, value) { if (CTX.writePlayerConfKey) CTX.writePlayerConfKey(key, value); }
/** 把配置里的 history-count 同步到 history-store 的保留上限（夹紧、容错） */
function syncHistoryLimit() { try { setHistoryLimit(getConfig().get('history-count')); } catch { /* 配置未就绪时忽略 */ } }

  ipcMain.handle('app:bootstrap', () => ({
    server: { port: getMediaServer().port, token: getMediaServer().token },
    config: getConfig().toJSON(),
    ffmpeg: getFfmpegCaps(),
    platform: process.platform,
    version: app.getVersion(),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    pendingFile: getPendingOpenFile(),
    hasFile: !!getPendingOpenFile(),
    resume: loadResume(),
    playlist: loadPlaylist(),
  }));


  // ---- 配置 ----

  ipcMain.handle('config:set', (_e, { key, value }) => {
    const v = getConfig().set(key, value);
    if (key.startsWith('opensubtitles-') || key === 'subtitles-proxy-url') {
      Subtitles.configure({
        apiKey: getConfig().get('opensubtitles-key') || '',
        user: getConfig().get('opensubtitles-user') || '',
        pass: getConfig().get('opensubtitles-pass') || '',
        proxyUrl: getConfig().get('subtitles-proxy-url') || '',
      });
    }
    if (key.startsWith('dandanplay-') || key === 'danmaku-proxy-url' || key === 'bilibili-cookie') {
      Danmaku.configure({
        dandanplayId: getConfig().get('dandanplay-id') || '',
        dandanplaySecret: getConfig().get('dandanplay-secret') || '',
        proxyUrl: getConfig().get('danmaku-proxy-url') || '',
        biliCookie: getConfig().get('bilibili-cookie') || '',
      });
    }
    syncHistoryLimit();
    return { ok: true, key, value: v };
  });


  // 把设置写回 player.conf（仅改指定键，保留注释与未改动的键）

  ipcMain.handle('config:save', (_e, { key, value }) => {
    const v = getConfig().set(key, value);
    writePlayerConfKey(key, v);
    // 关联到系统文件类型：写/清 HKCU 注册表
    if (key === 'file-association') {
      const r = applyFileAssociation(!!v);
      if (!r.ok) console.warn('[assoc] 注册文件关联失败:', r.error);
    }
    syncHistoryLimit();
    return { ok: true, key, value: v };
  });



  ipcMain.handle('config:reload', () => {
    getConfig().load();
    syncHistoryLimit();
    return { ok: true, config: getConfig().toJSON() };
  });



  ipcMain.handle('config:open-dir', () => {
    shell.openPath(getConfig().dir);
    return { ok: true };
  });


  // 恢复全部设置为默认值：重写 player.conf 为默认值（保留注释模板），
  // 并清空用户对 input.conf 的键位覆盖。重启后生效。

  ipcMain.handle('config:reset', () => {
    try {
      // 配置项回到默认：直接把 DEFAULTS 序列化回 player.conf。
      // 用 buildPlayerConfTemplate 风格的注释模板更友好，但为保留用户
      // 手工注释习惯，这里仅替换/追加默认值（不存在则追加）。
      const keys = Object.keys(getConfig().values);
      for (const k of keys) {
        const def = DEFAULTS[k];
        if (def === undefined) continue;
        const serialized = typeof def === 'boolean' ? (def ? 'yes' : 'no') : String(def);
        writePlayerConfKey(k, serialized);
      }
      // 清空键位覆盖：重置回脚手架里的空模板（仅注释，无覆盖）
      const inputPath = getConfig().inputConfPath;
      fs.writeFileSync(inputPath,
        '# 在此覆盖默认键位。语法与 mpv input.conf 相同。\n' +
        '# 例：把 s 改成截图并保存到桌面\n' +
        '#   s screenshot\n\n', 'utf8');
      getConfig().load();
      syncHistoryLimit();
      return { ok: true, config: getConfig().toJSON() };
    } catch (e) {
      console.error('[config] 恢复默认失败:', e.message);
      return { ok: false, error: e.message };
    }
  });


  // 导出默认键位表文本（mpv input.conf 格式），供用户参考或复制

  ipcMain.handle('config:export-keymap', () => {
    return { ok: true, text: DEFAULT_KEYBINDS };
  });


  // 保存用户键位覆盖：整段 input.conf 内容写回磁盘

  ipcMain.handle('config:save-keymap', (_e, { text }) => {
    try {
      fs.writeFileSync(getConfig().inputConfPath, text || '', 'utf8');
      getConfig().load();
      return { ok: true, config: getConfig().toJSON() };
    } catch (e) {
      console.error('[config] 保存键位失败:', e.message);
      return { ok: false, error: e.message };
    }
  });


  // 返回默认键位表与用户 input.conf 覆盖，供键位编辑器渲染 diff

  ipcMain.handle('config:get-keymap', () => {
    const defaults = parseInputConf(DEFAULT_KEYBINDS);
    let user = [];
    try {
      if (fs.existsSync(getConfig().inputConfPath)) {
        user = parseInputConf(fs.readFileSync(getConfig().inputConfPath, 'utf8'));
      }
    } catch (e) {
      console.error('[config] 读取 input.conf 失败:', e.message);
    }
    return { ok: true, defaults, user };
  });


  // ---- 用户脚本 ----

  ipcMain.handle('scripts:list', () => {
    if (!getConfig().get('scripts')) return [];
    try {
      return fs.readdirSync(getConfig().scriptsDir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => ({
          name: f,
          source: fs.readFileSync(path.join(getConfig().scriptsDir, f), 'utf8'),
        }));
    } catch {
      return [];
    }
  });


  // ---- 显示色彩管理 ----

  /**
   * 读取显示器 EDID 实测色度（WMI，仅 Windows 有效），用于 display-gamut=auto。
   * 返回 {red,green,blue,white} 分数制 xy（范围 0..1），或 {error}。
   * 失败（无显示器 / 非 Windows / 超时）一律回退到 sRGB，调用方据此走单位阵。
   */
  ipcMain.handle('system:display-profile', async () => {
    if (process.platform !== 'win32') return { error: 'unsupported-platform' };
    try {
      const ps = [
        '$c = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorColorCharacteristics -ErrorAction SilentlyContinue | Select-Object -First 1;',
        'if (-not $c) { Write-Output \'{"error":"no-monitor"}\'; exit 0; }',
        '$o = @{',
        '  red   = @{ x = [math]::Round($c.Red.X, 4);   y = [math]::Round($c.Red.Y, 4) };',
        '  green = @{ x = [math]::Round($c.Green.X, 4); y = [math]::Round($c.Green.Y, 4) };',
        '  blue  = @{ x = [math]::Round($c.Blue.X, 4);  y = [math]::Round($c.Blue.Y, 4) };',
        '  white = @{ x = [math]::Round($c.DefaultWhite.X, 4); y = [math]::Round($c.DefaultWhite.Y, 4) };',
        '};',
        'Write-Output ($o | ConvertTo-Json -Compress);',
      ].join(' ');
      const { stdout } = await execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 8000, windowsHide: true },
      );
      const txt = (stdout || '').trim();
      if (!txt || txt.includes('"error"')) {
        try { return JSON.parse(txt || '{"error":"empty"}'); } catch { return { error: 'empty' }; }
      }
      const ch = JSON.parse(txt);
      const ok = ['red', 'green', 'blue', 'white'].every(
        (k) => ch[k] && ch[k].x >= 0 && ch[k].x <= 1 && ch[k].y >= 0 && ch[k].y <= 1,
      );
      if (!ok) return { error: 'bad-chromaticity' };
      return ch;
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });

  /**
   * 让用户选择一个 .icc/.icm 显示器配置文件，主进程读取字节回传（渲染端解析矩阵）。
   * 返回 {name, bytes:ArrayBuffer} 或 {canceled:true} 或 {error}。
   */
  ipcMain.handle('system:open-icc', async () => {
    const win = BrowserWindow.getFocusedWindow();
    let res;
    try {
      res = await dialog.showOpenDialog(win || undefined, {
        title: '选择显示器 ICC 配置文件',
        filters: [{ name: 'ICC 配置文件', extensions: ['icc', 'icm'] }],
        properties: ['openFile'],
      });
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
    if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
    try {
      const buf = fs.readFileSync(res.filePaths[0]);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { name: path.basename(res.filePaths[0]), bytes: ab };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
}

module.exports = { register };
