/**
 * 续播位置管理(自包含模块,ctx 注入模式)。
 * 从 index.js 拆出(2026-08):watchLaterFile/readWatchLater/writeWatchLater/startResumeSaver。
 * 用法:resume.setCtx({ config, getCurrentInfo, getLastKnownTime, isIdle, isSmoke, saveResume });
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

let CTX = {};
function setCtx(ctx) { CTX = ctx || {}; }
function cfg() { return CTX.getConfig ? CTX.getConfig() : CTX.config; }

/* ------------------------------------------------------------------ */
/* 续播位置                                                             */
/* ------------------------------------------------------------------ */

function watchLaterFile(filePath) {
  const hash = crypto.createHash('md5').update(filePath).digest('hex');
  return path.join(cfg().watchLaterDir, hash + '.json');
}

function readWatchLater(filePath) {
  try {
    const f = watchLaterFile(filePath);
    if (!fs.existsSync(f)) return 0;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const t = Number(data.time) || 0;
    // 快播完了就别续播了，从头开始更合理
    const currentInfo = CTX.getCurrentInfo ? CTX.getCurrentInfo() : null;
    if (currentInfo && currentInfo.duration && t > currentInfo.duration - 10) return 0;
    return t > 5 ? t : 0;
  } catch {
    return 0;
  }
}

function writeWatchLater(filePath, time) {
  try {
    fs.mkdirSync(cfg().watchLaterDir, { recursive: true });
    fs.writeFileSync(watchLaterFile(filePath),
      JSON.stringify({ path: filePath, time, saved: Date.now() }), 'utf8');
  } catch { /* 写不进去就算了，不该因此打断退出流程 */ }
}

/**
 * 播放过程中定时（每 5s）把当前进度刷进续播存储。
 * 这样即便进程崩溃没走 before-quit，下次启动也能接着看。
 * 仅在"确实在播"（有文件、进度 >5s、且不在 idle 屏）时写入。
 */
let resumeSaverStarted = false;
function startResumeSaver() {
  if (resumeSaverStarted || (CTX.isSmoke && CTX.isSmoke())) return;
  resumeSaverStarted = true;
  setInterval(() => {
    try {
      const config = cfg();
      if (!config || !config.get('save-position-on-quit')) return;
      const currentInfo = CTX.getCurrentInfo ? CTX.getCurrentInfo() : null;
      const lastKnownTime = CTX.getLastKnownTime ? CTX.getLastKnownTime() : 0;
      if (!currentInfo || lastKnownTime <= 5 || (CTX.isIdle && CTX.isIdle())) return;
      CTX.saveResume({
        path: currentInfo.path,
        time: lastKnownTime,
        duration: currentInfo.duration || 0,
        title: currentInfo.title || path.basename(currentInfo.path),
        savedAt: Date.now(),
      });
    } catch { /* 定时任务里静默失败 */ }
  }, 5000);
}


module.exports = { setCtx, watchLaterFile, readWatchLater, writeWatchLater, startResumeSaver };
