'use strict';
// 下载歌词时间轴保障测试：
//   1) 在线返回带 syncedLyrics（[mm:ss.xx]）时，落盘的 .lrc 解析后每行都有有效时间轴；
//   2) 在线仅返回纯文本（无 syncedLyrics）时，downloadLyrics 拒绝落盘，绝不写出无时间轴的歌词。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { parseLrc, downloadLyrics } = require('../../src/main/ffmpeg/lyrics');

// 临时劫持 https.get，让 LRCLIB 两个端点返回我们指定的 JSON。
// get 端点返回带时间轴的 syncedLyrics；search 端点返回空（get 命中即停止）。
let _origGet = null;
function installHttpMock(getBody) {
  _origGet = https.get;
  https.get = (url, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    const u = (url instanceof URL) ? url : new URL(url);
    let body = '{}';
    if (u.pathname.endsWith('/api/get')) body = getBody;
    const res = {
      statusCode: 200,
      on: (ev, fn) => {
        if (ev === 'data') fn(body);
        else if (ev === 'end') fn();
      },
    };
    const req = { on: () => {}, destroy: () => {} };
    cb(res);
    return req;
  };
}
function restoreHttp() {
  if (_origGet) { https.get = _origGet; _origGet = null; }
}

const SYNCED = '[00:01.00]第一句歌词\n[00:02.50]第二句歌词\n[00:04.00]第三句歌词\n';

before(() => { restoreHttp(); });
after(() => { restoreHttp(); });

test('downloadLyrics 落盘的 .lrc 每行都带有效时间轴', async () => {
  installHttpMock(JSON.stringify({ syncedLyrics: SYNCED }));
  const base = path.join(os.tmpdir(), `lrc-sync-${process.pid}-${Date.now()}`);
  fs.writeFileSync(`${base}.mp3`, 'dummy');
  try {
    const r = await downloadLyrics(
      `${base}.mp3`,
      { title: '测试歌', artist: '测试人', duration: 200 },
      { simplified: false, includeCredits: false },
    );
    assert.equal(r.ok, true, '应下载成功');
    assert.ok(fs.existsSync(`${base}.lrc`), '应落盘 .lrc');
    const text = fs.readFileSync(`${base}.lrc`, 'utf8');
    const { lines } = parseLrc(text);
    assert.ok(lines.length >= 3, '应解析出歌词行');
    assert.ok(lines.some((l) => l.time > 0), '应至少存在一行带时间轴的歌词');
    for (const l of lines) {
      assert.equal(typeof l.time === 'number' && l.time >= 0, true, `歌词行「${l.text}」应带有效时间轴`);
    }
  } finally {
    try { fs.unlinkSync(`${base}.mp3`); } catch { /* noop */ }
    try { fs.unlinkSync(`${base}.lrc`); } catch { /* noop */ }
    restoreHttp();
  }
});

test('在线仅返回纯文本（无 syncedLyrics）时拒绝落盘，绝不写出无时间轴歌词', async () => {
  // get 与 search 都只返回 plainLyrics，无任何时间轴
  installHttpMock(JSON.stringify({ plainLyrics: '第一句歌词\n第二句歌词\n第三句歌词\n' }));
  const base = path.join(os.tmpdir(), `lrc-plain-${process.pid}-${Date.now()}`);
  fs.writeFileSync(`${base}.mp3`, 'dummy');
  try {
    const r = await downloadLyrics(
      `${base}.mp3`,
      { title: '测试歌', artist: '测试人', duration: 200 },
      { simplified: false, includeCredits: false },
    );
    assert.equal(r.ok, false, '无 syncedLyrics 时应下载失败');
    assert.equal(fs.existsSync(`${base}.lrc`), false, '绝不应落盘无时间轴的歌词');
  } finally {
    try { fs.unlinkSync(`${base}.mp3`); } catch { /* noop */ }
    try { fs.unlinkSync(`${base}.lrc`); } catch { /* noop */ }
    restoreHttp();
  }
});
