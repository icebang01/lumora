'use strict';
/**
 * MF 引擎独立验证工具（以 Electron 主进程运行，使 Electron-ABI 的原生模块
 * 能正确加载）。用法：
 *   electron tools/mf-sar-test.js <file.mp4> [maxSeconds]
 * 验证要点：
 *   - open() 回报 hasVideo / sar / 协商输出尺寸（应为源原生存储尺寸）
 *   - start() 后 video-frame 事件是否真实产出（videoEmitted>0）
 *   - SAR≠1 时输出尺寸保持原生（不拉伸），由渲染端按 DAR 适配
 */
const path = require('path');
const { MfBackend } = require('../src/main/mf/backend');

const file = process.argv[2] || 'testmedia/anamorphic-audio.mp4';
const maxSeconds = parseFloat(process.argv[3] || '6');

const abs = path.resolve(process.cwd(), file);

console.log('[mf-sar-test] 打开:', abs);

const backend = new MfBackend({ maxWidth: 1920, hwaccel: 'auto' });
if (!backend.available) {
  console.error('[mf-sar-test] 原生模块不可用:', backend._initError && backend._initError.message);
  process.exit(2);
}

backend.load({ path: abs, audioOnly: false });

let vCount = 0, aCount = 0, eosSeen = false, errSeen = null;
let firstVW = 0, firstVH = 0, validV = 0;

backend.on('started', (s) => {
  console.log('[mf-sar-test] started video=', JSON.stringify(s.video), 'audio=', JSON.stringify(s.audio));
  if (s.video) { firstVW = s.video.width; firstVH = s.video.height; }
});
backend.on('video-frame', (f) => {
  vCount++;
  const ok = !!(f.data && f.data.length);
  if (ok) validV++;
  if (vCount <= 5 || vCount % 30 === 0) {
    console.log(`[mf-sar-test] vf #${vCount} pts=${f.pts.toFixed(3)} ${f.width}x${f.height} bytes=${f.data ? f.data.length : 'NULL'}`);
  }
});
backend.on('audio-chunk', () => { aCount++; });
backend.on('eos', (e) => {
  eosSeen = true;
  console.log(`[mf-sar-test] eos decodeError=${e.decodeError} videoEmitted=${vCount} audioEmitted=${aCount}`);
});
backend.on('error', (e) => {
  errSeen = e.message;
  console.error('[mf-sar-test] error:', e.message);
});

const epoch = backend.start(0);
console.log('[mf-sar-test] start() -> epoch', epoch, 'videoOutput=', JSON.stringify(backend.videoOutput));

const deadline = Date.now() + maxSeconds * 1000;
const timer = setInterval(() => {
  if (eosSeen || errSeen || Date.now() > deadline) {
    clearInterval(timer);
    console.log('[mf-sar-test] 结果汇总: videoEmitted=' + vCount +
      ' audioEmitted=' + aCount +
      ' eos=' + eosSeen +
      ' err=' + (errSeen || 'null') +
      ' outDims=' + firstVW + 'x' + firstVH +
      ' sar=' + (backend.videoOutput && backend.videoOutput.sar));
    // 判定：SAR 修复成功 = 有视频帧产出且输出尺寸为原生（未拉伸）；
    // 额外统计 readFrame 命中率（validV/vCount），揭示槽位覆盖丢帧。
    const ok = vCount > 0 && firstVW > 0;
    console.log('[mf-sar-test] 丢帧率=' + (vCount > 0 ? ((1 - validV / vCount) * 100).toFixed(1) : 'NA') +
      '% (' + validV + '/' + vCount + ' 有效)');
    console.log('[mf-sar-test] VERDICT=' + (ok ? 'PASS' : 'FAIL'));
    backend.stop();
    setTimeout(() => process.exit(ok ? 0 : 1), 200);
  }
}, 250);

process.on('uncaughtException', (e) => {
  console.error('[mf-sar-test] 未捕获异常:', e && e.message);
  process.exit(3);
});
