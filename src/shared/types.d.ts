// Lumora 共享类型契约（JSDoc/checkJs 用，无运行时代码）
// 全局声明（本文件无 import/export → 顶层 interface 即全局类型）。
// 接入方式：src/shared/protocol.js 已 @ts-check；其余模块渐进接入。

/** 媒体包 32 字节定长头（解码后形态） */
interface PacketHeader {
  type: number;
  flags: number;
  /** 声部标签：0=主声部(A) 1=淡入淡出副声部(B) */
  voice: number;
  seq: number;
  pts: number;
  epoch: number;
  a: number;
  b: number;
  c: number;
}

/** writeHeader 的入参（可省略默认字段） */
interface PacketHeaderOptions {
  type: number;
  flags?: number;
  /** 声部标签（交叉淡入淡出副声部 = 1），默认 0 */
  voice?: number;
  seq?: number;
  pts?: number;
  epoch?: number;
  a?: number;
  b?: number;
  c?: number;
}

/** 像素格式描述（planarYUV 返回值） */
interface PixFmtInfo {
  name: string;
  bytesPerSample: number;
  bitDepth: number;
  planes: Array<{ key: string; wDiv: number; hDiv: number }>;
}

/**
 * IPC 模块 ctx 注入契约。
 * 各模块（register-ipc / ipc-* / windows / play-control / mpv-launch / media-pipeline…）
 * 通过 setCtx/register(ctx) 拿到宿主状态；共享可变状态（win/videoWin/mpvBackend/
 * pipeline/lastKnownTime/idleState）一律 getter/setter——单一事实源留在宿主。
 */
interface IpcCtx {
  getConfig(): any;
  getWin(): any;
  getVideoWin(): any;
  getCurrentInfo(): any;
  getUseMpv(): boolean;
  getMpvBackend(): any;
  getPipeline(): any;
  getLastKnownTime(): number;
  setLastKnownTime(v: number): void;
  getIdleState(): boolean;
  setIdleState(v: boolean): void;
  getMediaServer(): any;
  getFfmpegCaps(): any;
  getPendingOpenFile(): any;
  sendToRenderer(channel: string, payload?: any): void;
  writePlayerConfKey(k: string, v: unknown): void;
  formatTimeForFilename(t: number): string;
}
