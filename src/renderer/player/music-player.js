/**
 * 音乐播放器模块（自包含）。
 * 与 video-player.js 对称：持有独立的 ffmpeg 解码引擎（纯音频），音乐模式
 * （info.audioOnly）走这里，绝不启动 mpv、不涉及 videoWin（黑底视频窗口）。
 *
 * 引擎 = 内核 Player（ffmpeg 子进程 → WebSocket → AudioWorklet）。
 * 音乐模式下画面无意义，故用离屏 canvas 构造引擎；WebGL 不可用时自动降级为
 * 纯音频（voDisabled），与视频引擎行为一致。各引擎自身的 UI 订阅在创建时一次性
 * 绑定（音乐舞台在 ui/music-stage.js 通过 _observePlayer 订阅本引擎），共享 UI
 * （OSC/统计/设置）经 app.js 的 player 代理实时落到「活跃引擎」，无需重订阅。
 *
 * 用法：
 *   const music = await createMusicPlayer(bootstrapData, ctx);
 *   music.engine          // ffmpeg 音频引擎实例（Player）
 *   music.stop()          // 停止 ffmpeg 管线
 *   music.applyStage()    // 进入音频舞台
 */
import { Player } from '../core/player.js';

const $ = (id) => document.getElementById(id);

/**
 * 构造 music 专属引擎：离屏 canvas 仅用于满足 Player 构造（它要建立 VideoRenderer），
 * 音乐不渲染画面，voDisabled 后渲染分支被整体跳过。
 */
function createMusicEngine() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  return new Player(canvas, { audioOnly: true });
}

export async function createMusicPlayer(bootstrapData, ctx = {}) {
  const engine = createMusicEngine();
  await engine.init(bootstrapData);

  // 命令总线：把引擎内部的 playlist / eof / app-command 事件转回共享命令总线，
  // 保证音乐模式下列表自动续播、单曲循环兜底与视频模式完全一致。
  engine.addEventListener('playlist', (e) => {
    const a = e.detail && e.detail.action;
    if (a === 'playlist-next') { if (ctx.onPlaylistNext) ctx.onPlaylistNext(); }
    else if (a === 'playlist-prev') { if (ctx.onPlaylistPrev) ctx.onPlaylistPrev(); }
  });
  engine.addEventListener('eof', (e) => { if (ctx.onEof) ctx.onEof(e.detail); });
  engine.addEventListener('app-command', ({ detail }) => {
    if (ctx.runCommand) ctx.runCommand(detail.args);
  });

  return {
    engine,
    /** 停止 ffmpeg 管线（主进程按当前活跃后端停对应源） */
    async stop() {
      try { if (window.lumen && window.lumen.stop) await window.lumen.stop('music'); } catch { /* noop */ }
    },
    /** 进入音频舞台（body.audio-mode；真正的舞台切换由 player:loaded 的 enterAudioMode 负责） */
    applyStage() {
      document.body.classList.add('audio-mode');
    },
  };
}
