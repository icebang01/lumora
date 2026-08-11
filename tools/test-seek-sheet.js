'use strict';
// 临时验证：用 stub 替换 electron / thumbnail，直接调用 seek-sheet.generateSheet，
// 确认主进程侧能返回 ok:true + dataUrl（排除主进程 bug）。
const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ud = path.join(process.cwd(), '.seektest-ud');
const thumbs = path.join(ud, 'thumbs');
try { fs.mkdirSync(thumbs, { recursive: true }); } catch { /* */ }

const FFMPEG = path.join(process.cwd(), 'bin', 'ffmpeg.exe');

const fakeElectron = { app: { getPath: () => ud } };
const fakeThumb = {
  thumbsDir: () => thumbs,
  cacheKey: (p) => {
    let mtime = 0, size = 0;
    try { const st = fs.statSync(p); mtime = st.mtimeMs; size = st.size; } catch { /* */ }
    return crypto.createHash('md5').update(`${p}|${size}|${mtime}`).digest('hex');
  },
};
const fakeBinaries = { resolveBinary: () => FFMPEG };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === './thumbnail') return fakeThumb;
  if (request === './binaries') return fakeBinaries;
  return origLoad.apply(this, arguments);
};

const { generateSheet } = require('../src/main/ffmpeg/seek-sheet.js');

(async () => {
  const fp = path.resolve('testmedia/sdr-1080p.mp4');
  const r = await generateSheet(fp, null, { duration: 120, count: 24 });
  console.log('RESULT:', JSON.stringify({
    ok: r.ok, cols: r.cols, rows: r.rows, count: r.count,
    cellW: r.cellW, cellH: r.cellH, cached: r.cached,
    error: r.error, audio: r.audio,
    dataUrlLen: r.dataUrl ? r.dataUrl.length : 0,
  }));
  if (r.ok && r.dataUrl) {
    const buf = Buffer.from(r.dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(ud, 'sheet.jpg'), buf);
    console.log('wrote sheet.jpg bytes=', buf.length);
  }
  process.exit(r.ok ? 0 : 2);
})().catch((e) => { console.error('THREW:', e); process.exit(3); });
