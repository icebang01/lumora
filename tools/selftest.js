'use strict';
/**
 * 主进程管线自检。
 *
 * 播放器的 bug 大多藏在"看不见的地方"：帧长度算错一个字节、PTS 少
 * 加一个偏移、seek 后旧代际数据漏进来。这些问题在 GUI 上表现为
 * "偶尔花屏""音画好像有点飘"，靠肉眼调试极其低效。
 *
 * 所以把整条链路（探测 → 解码 → 分包 → WebSocket → 解析）拉出来
 * 无头跑一遍，用数值断言把问题钉死在具体环节。
 *
 *   node tools/selftest.js [媒体目录]
 */

const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const { probeMedia } = require('../src/main/ffmpeg/probe');
const { MediaPipeline } = require('../src/main/ffmpeg/decoder');
const { MediaServer } = require('../src/main/media-server');
const {
  HEADER_SIZE, PacketType, readHeader, frameSize, normalizePixFmt, planeLayout,
} = require('../src/shared/protocol');

const MEDIA_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'testmedia'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`   ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`   ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ================================================================== */
/* 1. 纯函数层                                                         */
/* ================================================================== */

function testPureFunctions() {
  console.log('\n[1] 协议与格式归一化');

  const cases = [
    ['yuv420p', 8, 'yuv420p'],
    ['yuvj420p', 8, 'yuv420p'],
    ['nv12', 8, 'yuv420p'],
    ['yuv422p', 8, 'yuv422p'],
    ['yuyv422', 8, 'yuv422p'],
    ['yuv444p', 8, 'yuv444p'],
    ['gbrp', 8, 'yuv444p'],
    ['yuv420p10le', 10, 'yuv420p10le'],
    ['p010le', 10, 'yuv420p10le'],
    ['yuv420p12le', 12, 'yuv420p10le'],
    ['yuv444p10le', 10, 'yuv444p10le'],
    ['gray', 8, 'yuv420p'],
  ];
  let ok = true;
  for (const [src, depth, want] of cases) {
    const got = normalizePixFmt(src, depth);
    if (got !== want) { ok = false; console.log(`     ${src}(${depth}bit) → ${got}，期望 ${want}`); }
  }
  check('像素格式归一化覆盖常见输入', ok, `${cases.length} 种`);

  // 帧长度必须与平面布局的总和严格一致，差一个字节整条流就错位
  let layoutOk = true;
  for (const fmt of ['yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv444p10le']) {
    for (const [w, h] of [[1920, 1080], [1280, 720], [640, 360]]) {
      const L = planeLayout(fmt, w, h);
      const sum = L.reduce((s, p) => s + p.bytes, 0);
      if (sum !== frameSize(fmt, w, h)) {
        layoutOk = false;
        console.log(`     ${fmt} ${w}x${h}: 布局 ${sum} ≠ 帧长 ${frameSize(fmt, w, h)}`);
      }
    }
  }
  check('平面布局总和 == 帧长度', layoutOk);

  check('1080p yuv420p 帧长', frameSize('yuv420p', 1920, 1080) === 1920 * 1080 * 1.5,
    `${frameSize('yuv420p', 1920, 1080)} 字节`);
  check('1080p yuv444p10le 帧长', frameSize('yuv444p10le', 1920, 1080) === 1920 * 1080 * 3 * 2,
    `${frameSize('yuv444p10le', 1920, 1080)} 字节`);
}

/* ================================================================== */
/* 2. 探测                                                             */
/* ================================================================== */

async function testProbe(file) {
  const info = await probeMedia(file);
  console.log(`   容器 ${info.container} · ${info.duration.toFixed(2)}s · ` +
    `视频 ${info.video.length} 音频 ${info.audio.length} 字幕 ${info.subtitle.length} ` +
    `章节 ${info.chapters.length}`);
  if (info.video[0]) {
    const v = info.video[0];
    console.log(`   视频轨: ${v.codec} ${v.width}x${v.height} ${v.fps.toFixed(3)}fps ` +
      `${v.pixfmt}(${v.bitDepth}bit) ${v.colorSpace}/${v.hdrType}` +
      `${v.rotation ? ` 旋转${v.rotation}°` : ''}`);
  }
  return info;
}

/* ================================================================== */
/* 3. 端到端管线                                                       */
/* ================================================================== */

/**
 * 拉起真实的解码进程 + WebSocket 服务，收够样本后做数值断言。
 */
function runPipeline(info, { seekTo = null, collect = 40 } = {}) {
  return new Promise(async (resolve, reject) => {
    const server = new MediaServer();
    const { port, token } = await server.listen();

    const pipeline = new MediaPipeline({ hwaccel: 'no' });
    pipeline.on('video-frame', (f) => server.sendVideoFrame(f));
    pipeline.on('audio-chunk', (c) => server.sendAudioChunk(c));
    pipeline.on('eos', ({ epoch }) => server.sendControl(PacketType.EOS, epoch));
    pipeline.on('error', (e) => log.errors.push(e.message));
    pipeline.on('log', ({ text }) => {
      const t = text.trim();
      if (t) log.errors.push(t);
    });
    server.onThrottleChange = (t) => pipeline.throttle(t);

    const log = {
      video: [], audio: [], errors: [], eos: false,
      epochsSeen: new Set(), badFrames: 0,
    };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    ws.binaryType = 'nodebuffer';

    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已关闭 */ }
      pipeline.stop();
      server.close();
      err ? reject(err) : resolve(log);
    };

    const timer = setTimeout(() => finish(null), 12000);

    ws.on('error', (e) => finish(e));

    ws.on('message', (buf) => {
      if (buf.length < HEADER_SIZE) { log.badFrames++; return; }
      const h = readHeader(new DataView(buf.buffer, buf.byteOffset, buf.length));
      const payload = buf.length - HEADER_SIZE;
      log.epochsSeen.add(h.epoch);

      if (h.type === PacketType.VIDEO) {
        log.video.push({ pts: h.pts, seq: h.seq, epoch: h.epoch, w: h.a, h: h.b, bytes: payload });
      } else if (h.type === PacketType.AUDIO) {
        log.audio.push({ pts: h.pts, seq: h.seq, epoch: h.epoch, frames: h.a, rate: h.b, ch: h.c, bytes: payload });
      } else if (h.type === PacketType.EOS) {
        log.eos = true;
        // 短文件（尤其是纯音频）可能在我们发出 seek 之前就播完了，
        // 这时立刻 seek，否则代际隔离这项永远测不到
        if (seekTo !== null && !sought) return doSeek();
        return finish(null);
      }

      if (seekTo !== null && !sought &&
          (log.video.length >= 10 || log.audio.length >= 24)) {
        return doSeek();
      }

      if (seekTo === null && log.video.length >= collect && log.audio.length >= collect / 2) {
        return finish(null);
      }
    });

    let sought = false;
    function doSeek() {
      if (sought) return;
      sought = true;
      log.seekAt = log.video.length;
      log.epoch2 = pipeline.seek(seekTo);
      // seek 后窗口：8K av1 软解（hwaccel:'no'）重启进程 + 解出首帧可能要数秒，
      // 2.5s 会让新代际帧为 0 误报（实测 8K 复仇者 av1 10bit 就是如此）。
      setTimeout(() => finish(null), 8000);
    }

    ws.on('open', () => {
      pipeline.load(info);
      log.epoch1 = pipeline.start(0);
      log.output = pipeline.videoOutput;
      // 视频轨太短或纯音频时，包可能来不及触发阈值，兜一个时限
      if (seekTo !== null) setTimeout(() => doSeek(), 2000);
    });
  });
}

async function testPlayback(file, info) {
  const log = await runPipeline(info, { collect: 40 });
  const out = log.output;

  if (info.hasVideo) {
    check('收到视频帧', log.video.length > 0, `${log.video.length} 帧`);
    if (!log.video.length) return log;

    const expect = frameSize(out.pixfmt, out.width, out.height);
    const wrongSize = log.video.filter((f) => f.bytes !== expect);
    check('每帧字节数与协议一致', wrongSize.length === 0,
      `${out.width}x${out.height} ${out.pixfmt} = ${expect} 字节`);

    const wrongDim = log.video.filter((f) => f.w !== out.width || f.h !== out.height);
    check('帧头尺寸与输出配置一致', wrongDim.length === 0);

    // PTS 必须严格单调递增，且间隔等于 1/fps
    let mono = true, spacingOk = true;
    const step = 1 / out.fps;
    for (let i = 1; i < log.video.length; i++) {
      const d = log.video[i].pts - log.video[i - 1].pts;
      if (d <= 0) mono = false;
      if (!near(d, step, step * 0.01)) spacingOk = false;
    }
    check('视频 PTS 单调递增', mono);
    check('视频 PTS 间隔 == 1/fps', spacingOk, `${(step * 1000).toFixed(2)}ms`);
    check('视频从 0 起播', near(log.video[0].pts, 0, step * 1.5),
      `首帧 pts=${log.video[0].pts.toFixed(4)}`);

    // 序号连续 = 中途没丢包
    const seqGaps = log.video.filter((f, i) => i > 0 && f.seq !== log.video[i - 1].seq + 1);
    check('视频序号连续无丢包', seqGaps.length === 0);
  }

  if (info.hasAudio) {
    check('收到音频块', log.audio.length > 0, `${log.audio.length} 块`);
    if (log.audio.length > 1) {
      const a = log.audio[0];
      check('音频格式为 48kHz 立体声', a.rate === 48000 && a.ch === 2, `${a.rate}Hz ${a.ch}ch`);
      check('音频块载荷长度正确', log.audio.every((c) => c.bytes === c.frames * c.ch * 4),
        `${a.frames} 帧 = ${a.bytes} 字节`);

      const astep = log.audio[0].frames / 48000;
      let aok = true;
      for (let i = 1; i < log.audio.length; i++) {
        if (!near(log.audio[i].pts - log.audio[i - 1].pts, astep, 1e-6)) aok = false;
      }
      check('音频 PTS 间隔恒定', aok, `${(astep * 1000).toFixed(2)}ms`);
    }
  }

  if (info.hasVideo && info.hasAudio && log.video.length && log.audio.length) {
    // 两个独立 ffmpeg 进程必须落在同一时间基上，否则从一开始就音画不同步
    const drift = Math.abs(log.video[0].pts - log.audio[0].pts);
    check('音视频起始时间基一致', drift < 0.05, `偏差 ${(drift * 1000).toFixed(1)}ms`);
  }

  check('无解码错误输出', log.errors.length === 0,
    log.errors.length ? log.errors[0].slice(0, 70) : '');

  return log;
}

async function testSeek(file, info) {
  const target = Math.min(8, Math.max(1, info.duration * 0.5));
  const log = await runPipeline(info, { seekTo: target });

  check('seek 后代际号递增', log.epoch2 > log.epoch1, `${log.epoch1} → ${log.epoch2}`);

  // 纯音频文件没有视频帧，改用音频包验证同一套代际逻辑
  const stream = info.hasVideo ? log.video : log.audio;
  const unit = info.hasVideo ? '帧' : '块';

  const after = stream.filter((f) => f.epoch === log.epoch2);
  check(`收到新代际的${unit}`, after.length > 0, `${after.length} ${unit}`);

  if (after.length) {
    check(`新${unit}从 seek 目标点开始`, near(after[0].pts, target, 0.5),
      `目标 ${target.toFixed(2)}s，实际 ${after[0].pts.toFixed(2)}s`);
    // 关键：seek 之后不能再冒出旧代际的数据，否则会闪回旧画面
    const idxFirstNew = stream.findIndex((f) => f.epoch === log.epoch2);
    const stale = stream.slice(idxFirstNew).filter((f) => f.epoch !== log.epoch2);
    check('旧代际数据已被完全隔离', stale.length === 0,
      stale.length ? `漏了 ${stale.length} ${unit}` : '');
  }
  return log;
}

/* ================================================================== */

async function main() {
  console.log('Lumen 主进程自检');
  console.log('='.repeat(64));

  testPureFunctions();

  if (!fs.existsSync(MEDIA_DIR)) {
    console.log(`\n找不到测试素材目录 ${MEDIA_DIR}`);
    console.log('先运行: npm run gen-testmedia');
    return report();
  }

  const files = fs.readdirSync(MEDIA_DIR)
    .filter((f) => /\.(mp4|mkv|mp3)$/i.test(f))
    .map((f) => path.join(MEDIA_DIR, f));

  let n = 1;
  for (const file of files) {
    console.log(`\n[${++n}] ${path.basename(file)}`);
    try {
      const info = await probeMedia(file);
      await testProbe(file);
      await testPlayback(file, info);
      if (info.duration > 4) await testSeek(file, info);
    } catch (err) {
      failed++;
      failures.push(path.basename(file));
      console.log(`   ✗ 异常: ${err.message}`);
    }
  }

  report();
}

function report() {
  console.log('\n' + '='.repeat(64));
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failures.length) {
    console.log('失败项:');
    for (const f of new Set(failures)) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
