'use strict';
/**
 * Lumora 主进程。
 *
 * 职责边界很清楚：
 *   主进程   = 进程管理、文件系统、窗口、解码编排
 *   渲染进程 = 时钟、同步、GPU 渲染、UI、键位
 *
 * 裸流数据不走这里的 IPC（见 media-server.js 的说明），
 * 这条 IPC 通道只传控制指令和状态，量很小。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const resume = require('./resume');
const { startResumeSaver, writeWatchLater } = resume;
const mediaAuto = require('./media-auto');
const pip = require('./pip');
const { sanitizeInfo } = pip;
const playControl = require('./play-control');
const { loadFile, currentDar } = playControl;
const windows = require('./windows');
const { createWindow, resyncNow } = windows;
const ipc = require('./register-ipc');
const mpvLaunch = require('./mpv-launch');
const mediaPipeline = require('./media-pipeline');
const { createMpvBackend, startMpv, resolveMpvPath } = mpvLaunch;
const { spawn } = require('child_process');

const { Config, parseArgv } = require('./config');
const { setHistoryLimit } = require('./history-store');
const { MediaPipeline } = require('./ffmpeg/decoder');
const { MediaServer } = require('./media-server');
const { resolveBinary, probeCapabilities } = require('./ffmpeg/binaries');
const { IpcJsonServer } = require('./ipc-server');
const { PacketType } = require('../shared/protocol');
const { MpvBackend } = require('./mpv-backend');
const { saveResume } = require('./resume-store');
const Subtitles = require('./subtitles');
const Danmaku = require('./danmaku');
const MediaApply = require('./media-apply');
const AiBridge = require('./ai-bridge');
const { getManager } = require('./ipc-cast');
const updater = require('./updater');
const desktopLyrics = require('./desktop-lyrics');

// Windows 下若从 pipe/终端启动后父进程关闭读端，console.log 写 stdout 会抛 EPIPE
// 并把主进程崩掉。这里安静忽略 EPIPE，避免一个日志把播放器写死。
function ignoreEpipe(err) { if (err && err.code === 'EPIPE') return; }
if (process.stdout) process.stdout.on('error', ignoreEpipe);
if (process.stderr) process.stderr.on('error', ignoreEpipe);

// ── Windows 控制台编码说明 ──────────────────────────────────────────────
// 控制台中文乱码原因：Windows 终端默认代码页 GBK(936)，Node 输出 UTF-8 字节
// → 终端按 GBK 解读 UTF-8 字节 → 乱码。这是纯开发调试观感问题（用户看不到此窗口）。
//
// 已验证所有"在 Electron 主进程内改代码页"的方案均有副作用：
//   setEncoding('utf8')   -> 崩溃（Electron 的 process.stdout 是 stub）
//   execSync('chcp ...')  -> 卡死（阻塞主事件循环 -> "应用程序无响应"）
//   spawn + shell+inherit  -> 同上卡死
//   spawn + windowsHide   -> 不生效（无法继承控制台句柄）
//
// 如需控制台中文正常显示：在启动前先手动执行  chcp 65001
// 子进程(mpv/ffmpeg) stderr 已用 toString('utf8') 解码（现代版输出 UTF-8）

// 关闭 Electron 的默认菜单快捷键，否则 Ctrl+W 之类会被系统抢走，
// 我们要让所有键位都由自研的绑定系统统一处理
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 允许在集显/远程桌面环境下也强制走 GPU 合成，否则 WebGL 会掉到软件光栅
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
// 远程桌面 / 虚拟显示器（如 Parsec）下 GPU 沙箱会阻止 WebGL2 上下文创建，
// 禁用沙箱让 GPU 进程直通，否则播放器会降级为纯音频模式
app.commandLine.appendSwitch('disable-gpu-sandbox');
// 强制使用 OpenGL ANGLE 后端，D3D11 在远程会话中经常不可用
app.commandLine.appendSwitch('use-angle', 'gl');
// 禁用 Chromium 的 WebAudio/媒体自动播放策略：音乐播放器需要拖入文件或
// 启动后立即发声，不能把首次出声绑定到 click/keydown 等手势。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
console.log('[lumen][autoplay] commandLine autoplay-policy=' + app.commandLine.getSwitchValue('autoplay-policy'));

const IS_DEV = process.argv.includes('--dev');

/**
 * 无人值守冒烟测试：--smoke-test[=秒数]
 *
 * 播放器最难验的部分恰恰是必须有窗口才能跑的那一半 —— WebGL 上下文、
 * AudioWorklet、requestAnimationFrame 驱动的同步循环。这个模式真启一次
 * 窗口，用命令总线跑一遍典型操作，读回渲染端状态做断言，然后自己退出。
 */
const SMOKE = (() => {
  const arg = process.argv.find((a) => a.startsWith('--smoke-test'));
  if (!arg) return null;
  const n = Number(arg.split('=')[1]);
  return { budget: Number.isFinite(n) && n > 0 ? n : 12 };
})();

/**
 * 对话框取消后黑屏专项测试：--test-dialog-cancel
 *
 * 自动打开文件对话框，500ms 后发送 Escape 取消，截图检查 idle 屏是否
 * 正常显示（非全黑）。用于回归验证 Windows 透明无边框窗口在模态对话框
 * 关闭后的重绘问题。
 */
const TEST_DIALOG_CANCEL = process.argv.includes('--test-dialog-cancel');
/** 设置窗口构建测试：--test-open-settings（验证 F2 设置面板能正常构建） */
const TEST_OPEN_SETTINGS = process.argv.includes('--test-open-settings');
/** 设置窗口双击穿透测试：--test-settings-dblclick（验证双击设置面板不会触发打开文件） */
const TEST_SETTINGS_DBLCLICK = process.argv.includes('--test-settings-dblclick');
/** 设置项即时生效测试：--test-settings-apply（验证切换设置会立即反映到界面/播放器） */
const TEST_SETTINGS_APPLY = process.argv.includes('--test-settings-apply');
/** 键位速查面板测试：--test-keymap（验证键位面板可打开、可关闭、内容非空） */
const TEST_KEYMAP = process.argv.includes('--test-keymap');
/** 文件关联测试：--test-file-assoc（验证 argv / app:open-file 链路能触发打开文件） */
const TEST_FILE_ASSOC = process.argv.includes('--test-file-assoc');
/** 续播 UI 测试：--test-resume（验证 idle 屏出现"继续观看"卡片，点击可载入） */
const TEST_RESUME = process.argv.includes('--test-resume');
/** 播放列表测试：--test-playlist（验证多文件入队、next/prev/goto/remove、面板渲染） */
const TEST_PLAYLIST = process.argv.includes('--test-playlist');
const TEST_LOOPMODE = process.argv.includes('--test-loopmode');

let smokeTestModule = null;
function getSmokeTest() {
  if (!smokeTestModule) smokeTestModule = require('./smoke-test');
  return smokeTestModule;
}

let win = null;       // UI 窗口（渲染 HTML，透明，在顶层）
let videoWin = null;  // 视频窗口（仅给 mpv 提供 HWND，在底层）
let config = null;
let pipeline = null;
let secondaryPipeline = null; // 交叉淡入淡出副声部（并发第二解码管线，voice=1）
let mediaServer = null;
let jsonIpc = null;
let currentInfo = null;
let ffmpegCaps = null;
let lastKnownTime = 0;
let pendingOpenFile = null;
let idleState = true; // idle 屏当前是否可见（续播定时保存时据此判断是否在播）
let mpvBackend = null; // 播放后端（mpv，带 HWND 嵌入窗口）
let useMpv = true; // 使用 mpv 作为播放后端

/**
 * 统一访问器（音乐模式已于 2026-08-07 移除，仅剩视频后端）。
 * 保留 source 参数签名以兼容调用方，恒返回 mpvBackend。保持单一事实源。
 */
function getBackend() { return mpvBackend; }
function setBackend(source, v) { mpvBackend = v; }

/* ------------------------------------------------------------------ */
/* 配置目录解析                                                         */
/* ------------------------------------------------------------------ */

function resolveConfigDir(cliOptions) {
  if (cliOptions['config-dir']) return path.resolve(String(cliOptions['config-dir']));
  // 便携模式：可执行文件旁若有 portable_config 就优先用它
  const portable = path.join(path.dirname(app.getPath('exe')), 'portable_config');
  if (fs.existsSync(portable)) return portable;
  // 从源码运行（electron . 未打包）时，main 模块不在 asar 包内，
  // 使用项目目录下的 config 保持开发体验一致
  const mainInAsar = __dirname.includes('app.asar');
  if (!mainInAsar) return path.join(__dirname, '..', '..', 'config');
  return path.join(app.getPath('userData'), 'config');
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * 播放状态快照，供 AI 助手的 get_state / debug_player 工具使用。
 * 仅聚合即可得字段，避免在渲染端反复轮询。
 */
function getPlayerState() {
  return {
    path: currentInfo ? currentInfo.path : null,
    duration: currentInfo && currentInfo.duration != null ? currentInfo.duration : null,
    time: lastKnownTime,
    pause: currentInfo ? !!currentInfo.pause : null,
    speed: config.get('speed'),
    videoTracks: currentInfo && currentInfo.video ? currentInfo.video.length : 0,
    audioTracks: currentInfo && currentInfo.audio ? currentInfo.audio.length : 0,
    subtitleTracks: currentInfo && currentInfo.subtitle ? currentInfo.subtitle.length : 0,
  };
}

/* ------------------------------------------------------------------ */



function formatTimeForFilename(t) {
  const s = Math.floor(t || 0);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}.${mm}.${ss}`;
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                             */
/* ------------------------------------------------------------------ */

/**
 * 取出真正属于用户的命令行参数。
 *
 * 打包后 argv[0] 是可执行文件；从源码跑时 argv[0] 是 electron、
 * argv[1] 是应用目录（`electron .` 里的那个点）。判据用 app.isPackaged
 * 而不是 --dev，否则 `npm start` 会把 "." 当成待播文件。
 */
function userArgs(argv) {
  const raw = argv.slice(app.isPackaged ? 1 : 2);
  const appDir = path.resolve(app.getAppPath());
  return raw.filter((a) => {
    if (a.startsWith('-')) return true;
    try { return path.resolve(a) !== appDir; } catch { return true; }
  });
}

async function bootstrap() {
  // 窗口模块上下文注入（win/videoWin 是 index.js 的顶层变量，读写走 getter/setter 保持单一事实源）
  windows.setCtx({
    getWin: () => win,
    setWin: (v) => { win = v; },
    getVideoWin: () => videoWin,
    setVideoWin: (v) => { videoWin = v; },
    getConfig: () => config,
    getUseMpv: () => useMpv,
    getCurrentInfo: () => currentInfo,
    getIsDev: () => IS_DEV,
    getIsSmoke: () => SMOKE,
    sendToRenderer,
    startMpv: (w) => startMpv(w),
  });
  // MPV 后端启动模块上下文注入（mpvBackend 是 index.js 顶层变量，
  // 读写走 getBackend/setBackend 统一访问器保持单一事实源）
  mpvLaunch.setCtx({
    getConfig: () => config,
    getMpvBackend: () => mpvBackend,
    setMpvBackend: (v) => { mpvBackend = v; },
    getBackend,
    setBackend,
    sendToRenderer,
  });
  // ffmpeg 引擎解码编排模块上下文注入（pipeline 是 index.js 顶层变量，读写走 getter/setter 保持单一事实源）
  mediaPipeline.setCtx({
    getConfig: () => config,
    getPipeline: () => pipeline,
    setPipeline: (v) => { pipeline = v; },
    getSecondaryPipeline: () => secondaryPipeline,
    setSecondaryPipeline: (v) => { secondaryPipeline = v; },
    getMediaServer: () => mediaServer,
    getCurrentInfo: () => currentInfo,
    getLastKnownTime: () => lastKnownTime,
    sendToRenderer,
  });
  // 播放控制模块上下文注入(config 等为启动后才赋值的顶层变量,必须用 getter)
  playControl.setCtx({
    getConfig: () => config,
    getWin: () => win,
    getVideoWin: () => videoWin,
    getUseMpv: () => useMpv,
    getMpvBackend: () => mpvBackend,
    getBackend,
    getPipeline: () => pipeline,
    getMediaServer: () => mediaServer,
    getCurrentInfo: () => currentInfo,
    setCurrentInfo: (v) => { currentInfo = v; },
    getLastKnownTime: () => lastKnownTime,
    setLastKnownTime: (v) => { lastKnownTime = v; },
    getIsSmoke: () => SMOKE,
    sendToRenderer,
    resyncNow,
    startMpv: (w) => startMpv(w),
    startCrossfade: (info, reqId) => mediaPipeline.startCrossfade(info, reqId),
    endCrossfade: () => mediaPipeline.endCrossfade(),
    commitCrossfade: () => mediaPipeline.commitCrossfade(),
  });
  // 画中画模块上下文注入
  pip.setCtx({
    getWin: () => win,
    getVideoWin: () => videoWin,
    sendToRenderer,
    getUseMpv: () => useMpv,
    getCurrentDar: () => currentDar(),
  });
  // 字幕/弹幕模块上下文注入
  mediaAuto.setCtx({
    getConfig: () => config,
    sendToRenderer,
    Subtitles,
    Danmaku,
    MediaApply,
    useMpv,
    get mpvBackend() { return mpvBackend; },
  });
  // 续播模块上下文注入(config 是启动后才赋值的顶层变量,必须用 getter)
  resume.setCtx({
    getConfig: () => config,
    getCurrentInfo: () => currentInfo,
    getLastKnownTime: () => lastKnownTime,
    isIdle: () => idleState,
    isSmoke: () => SMOKE,
    saveResume,
  });
  const { options, files } = parseArgv(userArgs(process.argv));

  config = new Config(resolveConfigDir(options));
  config.ensureScaffold();
  config.applyCli(options);
  config.load();
  // 把"最近播放"保留上限同步给 history-store（来自配置 history-count，默认 5）
  setHistoryLimit(config.get('history-count'));

  // 在线字幕（OpenSubtitles + 可选代理）：把凭据喂给客户端，并准备缓存目录
  Subtitles.configure({
    apiKey: config.get('opensubtitles-key') || '',
    user: config.get('opensubtitles-user') || '',
    pass: config.get('opensubtitles-pass') || '',
    proxyUrl: config.get('subtitles-proxy-url') || '',
  });
  Subtitles.setCacheDir(path.join(config.dir, 'subtitles'));

  // 弹幕（弹弹play / B 站 / 可自托管代理）：喂凭据
  Danmaku.configure({
    dandanplayId: config.get('dandanplay-id') || '',
    dandanplaySecret: config.get('dandanplay-secret') || '',
    proxyUrl: config.get('danmaku-proxy-url') || '',
    biliCookie: config.get('bilibili-cookie') || '',
  });

  // 播放后端：mpv（默认，进程内 GPU 解码，最稳，支持 8K / Dolby Vision）/ ffmpeg（内置 LGPL 解码管线，纯音频与兜底）。
  // LUMORA_ENGINE 环境变量可临时覆盖（仅内存生效，不写回 player.conf），
  // 用于在无头/CI 环境用 `LUMORA_ENGINE=ffmpeg npm run test:smoke` 回归 ffmpeg 引擎。
  const engine = process.env.LUMORA_ENGINE || config.get('engine') || 'mpv';
  config.values.engine = engine; // 让渲染端 bootstrap 与主进程判定一致（同走 engineName）
  useMpv = engine === 'mpv';

  // 提前创建 mpv 后端（只接线事件，不 spawn 进程）：
  // 渲染端 boot() 触发 loadFile 可能早于 startMpv（ready-to-show 后延迟
  // 300ms），若 mpvBackend 为 null，loadFile 的 mpv 分支会被跳过，文件
  // 永远不进 mpv → time-pos 恒 0。详见 createMpvBackend 的注释。
  if (!mpvBackend) {
    const mpvPath = resolveMpvPath();
    if (mpvPath) createMpvBackend('video', { mpvPath });
  }

  const ffmpegPath = resolveBinary('ffmpeg', config.get('ffmpeg-dir') || null);
  ffmpegCaps = { path: ffmpegPath, ...probeCapabilities(ffmpegPath) };

  mediaServer = new MediaServer();
  await mediaServer.listen();

  // 解码后端装配：mpv（视频 GPU 解码）/ ffmpeg（LGPL 内置解码管线，纯音频与视频兜底）
  // 二者经 mediaPipeline.wirePipeline 接同一套 WebSocket 发送 + 背压，控制面零改动。
  mediaPipeline.setupPipeline();

  if (files.length) pendingOpenFile = path.resolve(files[0]);

  ipc.setCtx({
    getConfig: () => config,
    getMediaServer: () => mediaServer,
    getFfmpegCaps: () => ffmpegCaps,
    getPendingOpenFile: () => pendingOpenFile,
    getCurrentInfo: () => currentInfo,
    getUseMpv: () => useMpv,
    getMpvBackend: () => mpvBackend,
    getBackend,
    getPipeline: () => pipeline,
    getLastKnownTime: () => lastKnownTime,
    setLastKnownTime: (v) => { lastKnownTime = v; },
    getIdleState: () => idleState,
    setIdleState: (v) => { idleState = v; },
    getWin: () => win,
    getVideoWin: () => videoWin,
    sendToRenderer,
    writePlayerConfKey,
    deletePlayerConfKey,
    formatTimeForFilename,
  });
  // 桌面歌词窗口模块：注入配置目录用于持久化位置/字号
  desktopLyrics.setCtx({ getConfigDir: () => config.dir, notify: sendToRenderer });
  ipc.registerIpc();

  // 自动更新（GitHub Releases）：dev 模式自动禁用，打包版启动后静默检查
  updater.setCtx({ getWin: () => win, sendToRenderer });
  updater.setup();

  // AI 助手桥接：托管 assistant 并注册 player:ai:* IPC（provider 未配 key 时自动走离线桩）
  AiBridge.initAiBridge({
    config,
    Subtitles,
    Danmaku,
    sendToRenderer,
    getCurrentInfo: () => currentInfo,
    getState: getPlayerState,
    useMpv,
    subAdd: (p) => {
      if (useMpv && mpvBackend && mpvBackend.ready) {
        mpvBackend.command('sub-add', p, 'select').catch((e) => console.warn('[lumen][ai][sub] sub-add 失败:', e.message));
      }
    },
  });
  createWindow();
  startResumeSaver();

  // JSON IPC：外部程序遥控
  const ipcPath = config.get('input-ipc-server');
  if (ipcPath) {
    jsonIpc = new IpcJsonServer(ipcPath);

    // 命令要转给渲染进程执行（状态机在那边），但 get_property 这类
    // 请求必须把结果带回来。所以按 request_id 挂起，等渲染端回话。
    const pending = new Map();

    jsonIpc.on('command', (cmd, respond) => {
      if (!win || win.isDestroyed()) return respond({ error: 'no window' });
      win.webContents.send('ipc:command', cmd);

      if (cmd.request_id === undefined) {
        return respond({ error: 'success' });
      }
      // 渲染端卡住时不能让客户端永远等下去
      const timer = setTimeout(() => {
        if (pending.delete(cmd.request_id)) {
          respond({ error: 'timeout', request_id: cmd.request_id });
        }
      }, 3000);
      pending.set(cmd.request_id, { respond, timer });
    });

    jsonIpc.start().catch((e) => console.error('[ipc] 启动失败:', e.message));

    ipcMain.on('ipc:event', (_e, payload) => {
      if (!jsonIpc) return;
      // 带 request_id 的是应答，点对点回给发起者；其余是事件，广播
      if (payload && payload.request_id !== undefined && pending.has(payload.request_id)) {
        const { respond, timer } = pending.get(payload.request_id);
        pending.delete(payload.request_id);
        clearTimeout(timer);
        respond(payload);
        return;
      }
      jsonIpc.broadcast(payload);
    });
  }

  if (SMOKE) {
    // 兜底：任何一步卡死都不能让进程永远挂在那儿
    setTimeout(() => {
      if (!smokeDone) {
        console.error(`[smoke] 超时（${SMOKE.budget * 6}s），强制退出`);
        teardown();
        setTimeout(() => process.exit(2), 3000).unref();
        app.exit(2);
      }
    }, SMOKE.budget * 6000).unref?.();
    getSmokeTest().runSmokeTest(win, { teardown, pendingOpenFile, currentInfo });
  }

  if (TEST_DIALOG_CANCEL) {
    setTimeout(() => getSmokeTest().runDialogCancelTest().catch((e) => {
      console.error('[dialog-cancel-test] 异常:', e);
      app.exit(2);
    }), 1200);
  }

  if (TEST_OPEN_SETTINGS) {
    setTimeout(() => getSmokeTest().runOpenSettingsTest().catch((e) => {
      console.error('[open-settings-test] 异常:', e);
      app.exit(2);
    }), 1500);
  }

  if (TEST_SETTINGS_DBLCLICK) {
    setTimeout(() => getSmokeTest().runSettingsDblclickTest().catch((e) => {
      console.error('[settings-dblclick-test] 异常:', e);
      app.exit(2);
    }), 1500);
  }

  if (TEST_SETTINGS_APPLY) {
    setTimeout(() => getSmokeTest().runSettingsApplyTest().catch((e) => {
      console.error('[settings-apply-test] 异常:', e);
      app.exit(2);
    }), 1500);
  }

  if (TEST_KEYMAP) {
    setTimeout(() => getSmokeTest().runKeymapTest().catch((e) => {
      console.error('[keymap-test] 异常:', e);
      app.exit(2);
    }), 1500);
  }

  if (TEST_FILE_ASSOC) {
    setTimeout(() => getSmokeTest().runFileAssocTest().catch((e) => {
      console.error('[file-assoc-test] 异常:', e);
      app.exit(2);
    }), 1500);
  }

  if (TEST_RESUME) {
    setTimeout(() => getSmokeTest().runResumeTest().catch((e) => {
      console.error('[resume-test] 异常:', e);
      app.exit(2);
    }), 1500);
  }

  if (TEST_PLAYLIST) {
    setTimeout(() => getSmokeTest().runPlaylistTest().catch((e) => {
      console.error('[playlist-test] 异常:', e);
      app.exit(2);
    }), 1500);
  }

  if (TEST_LOOPMODE) {
    setTimeout(() => getSmokeTest().runLoopModeTest().catch((e) => {
      console.error('[loopmode-test] 异常:', e);
      app.exit(2);
    }), 1500);
  }
}

let smokeDone = false;

/* ------------------------------------------------------------------ */
/* 冒烟测试                                                             */
/* ------------------------------------------------------------------ */


/**
 * 把单个配置键写回 player.conf。
 * 只替换/追加指定键的那一行，保留其余内容与注释，避免覆盖用户手动改过的项。
 */
function writePlayerConfKey(key, value) {
  if (!config || !config.playerConfPath) return;
  const file = config.playerConfPath;
  const serialized = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
  let lines = [];
  if (fs.existsSync(file)) {
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { lines = []; }
  }
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([\w-]+)\s*=/);
    if (m && m[1] === key) { lines[i] = `${key}=${serialized}`; replaced = true; break; }
  }
  if (!replaced) lines.push(`${key}=${serialized}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n'));
  } catch (e) {
    console.error(`[config] 写入 ${file} 失败:`, e.message);
  }
}

/**
 * 从 player.conf 删除单个配置键（保留其余内容与注释）。用于软件关闭时清除
 * 各播放样式的窗口位置记忆（music-style-bounds-*），使下次启动首次进入用主页位置。
 */
function deletePlayerConfKey(key) {
  if (!config || !config.playerConfPath) return;
  const file = config.playerConfPath;
  if (!fs.existsSync(file)) return;
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return; }
  const out = lines.filter((l) => {
    const m = l.match(/^\s*([\w-]+)\s*=/);
    return !(m && m[1] === key);
  });
  try {
    fs.writeFileSync(file, out.join('\n'));
  } catch (e) {
    console.error(`[config] 删除 ${file} 键 ${key} 失败:`, e.message);
  }
}

app.whenReady().then(bootstrap).catch((err) => {
  dialog.showErrorBox('Lumora 启动失败', err.stack || err.message);
  app.quit();
});

// 单实例：第二次启动时把文件交给已有窗口，而不是开新进程
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const { files } = parseArgv(userArgs(argv));
    if (files.length && win) {
      const fp = path.resolve(files[0]);
      loadFile(fp);
      sendToRenderer('app:open-file', { path: fp });
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// macOS：从 Finder 打开文件
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (win) {
    loadFile(filePath);
    sendToRenderer('app:open-file', { path: filePath });
  } else {
    pendingOpenFile = filePath;
  }
});

/**
 * 释放所有外部资源。
 *
 * 必须能被重复调用且绝不抛异常 —— 它同时挂在正常退出路径和
 * 强制退出路径上，任何一处抛错都会把进程卡在半死不活的状态。
 *
 * 尤其是 ffmpeg：Windows 上子进程不随父进程消亡，漏杀就是孤儿进程
 * 死攥着媒体文件句柄，用户下次想删那个文件都删不掉。
 */
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  try { if (globalShortcut) globalShortcut.unregisterAll(); } catch { /* 忽略 */ }
  try { if (mpvBackend) mpvBackend.destroy(); } catch { /* 已经停了 */ }
  try { if (pipeline) pipeline.stop(); } catch { /* 已经停了 */ }
  try { if (mediaServer) mediaServer.close(); } catch { /* 已经关了 */ }
  try { if (jsonIpc) jsonIpc.stop(); } catch { /* 已经停了 */ }
  try { const m = getManager(); if (m) m.stopAll(); } catch { /* 已经停了 */ }
  try { if (videoWin && !videoWin.isDestroyed()) videoWin.destroy(); } catch { /* 已经关了 */ }
  try { desktopLyrics.teardownWindow(); } catch { /* 已经关了 */ }
}

app.on('before-quit', () => {
  // 冒烟测试是自动化行为，不该往用户的续播记录里塞脏数据
  if (!SMOKE && config && config.get('save-position-on-quit') && currentInfo && lastKnownTime > 5) {
    writeWatchLater(currentInfo.path, lastKnownTime);
    saveResume({
      path: currentInfo.path,
      time: lastKnownTime,
      duration: currentInfo.duration || 0,
      title: currentInfo.title || path.basename(currentInfo.path),
      savedAt: Date.now(),
    });
  }
  teardown();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// GPU 进程崩溃时给出可诊断的提示，而不是白屏
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU') {
    console.error('[gpu] 进程异常:', details.reason);
  }
});

nativeTheme.themeSource = 'dark';
