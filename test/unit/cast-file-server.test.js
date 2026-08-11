'use strict';
// 投屏 LAN 文件服务（block #5）单测：
//  - 纯助手：resolveMime / getLanIp(注入接口) / parseRange
//  - 集成：真实 loopback http 服务，验证 200 + Content-Type + Range 206 + 停止
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { resolveMime, getLanIp, parseRange, CastFileServer } = require('../../src/main/cast/file-server');

/* ---------- 纯助手 ---------- */

test('resolveMime：常见扩展名', () => {
  assert.strictEqual(resolveMime('/a/b.mp4'), 'video/mp4');
  assert.strictEqual(resolveMime('clip.MKV'), 'video/x-matroska');
  assert.strictEqual(resolveMime('x.webm'), 'video/webm');
  assert.strictEqual(resolveMime('song.flac'), 'audio/flac');
  assert.strictEqual(resolveMime('noext'), 'application/octet-stream');
});

test('getLanIp：优先私有段，跳过回环/链路本地', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth0: [
      { family: 'IPv4', address: '192.168.1.20', internal: false },
      { family: 'IPv4', address: '169.254.1.2', internal: false }, // 链路本地跳过
    ],
  };
  assert.strictEqual(getLanIp({ getInterfaces: () => ifaces }), '192.168.1.20');
});

test('getLanIp：无可用接口回退 127.0.0.1', () => {
  assert.strictEqual(getLanIp({ getInterfaces: () => ({}) }), '127.0.0.1');
});

test('parseRange：单段范围 / 缺失 / 越界', () => {
  assert.deepStrictEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.strictEqual(parseRange('', 1000), null);
  assert.strictEqual(parseRange('bytes=9999-', 1000), null); // 越界
});

/* ---------- 集成：真实 loopback 服务 ---------- */

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

test('CastFileServer：起服务 → 200 + 正确 MIME + 内容；Range → 206', async () => {
  const tmp = path.join(os.tmpdir(), `lumora-cast-${process.pid}.bin`);
  const payload = Buffer.from('LumoraCastTestPayload-1234567890');
  fs.writeFileSync(tmp, payload);

  const srv = new CastFileServer();
  const info = await srv.start(tmp, 'video/mp4');
  assert.ok(srv.serving);
  assert.ok(info.port > 0);

  // 用 127.0.0.1 + 返回端口访问（服务绑定 0.0.0.0，回环可达）
  const url = `http://127.0.0.1:${info.port}/cast`;

  const full = await httpGet(url);
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.headers['content-type'], 'video/mp4');
  assert.strictEqual(full.headers['accept-ranges'], 'bytes');
  assert.strictEqual(full.body.toString('utf8'), payload.toString('utf8'));

  const ranged = await httpGet(url, { Range: 'bytes=0-9' });
  assert.strictEqual(ranged.status, 206);
  assert.strictEqual(ranged.headers['content-range'], `bytes 0-9/${payload.length}`);
  assert.strictEqual(ranged.body.toString('utf8'), payload.slice(0, 10).toString('utf8'));

  srv.stop();
  assert.strictEqual(srv.serving, false);

  // 停止后访问应失败（连接被拒）
  await assert.rejects(httpGet(url));
  fs.unlinkSync(tmp);
});

test('CastFileServer：HEAD 返回头无体', async () => {
  const tmp = path.join(os.tmpdir(), `lumora-cast-head-${process.pid}.bin`);
  fs.writeFileSync(tmp, Buffer.from('headtest'));
  const srv = new CastFileServer();
  const info = await srv.start(tmp);
  const res = await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${info.port}/cast`, { method: 'HEAD' }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, len: Buffer.concat(chunks).length, cl: r.headers['content-length'] }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.len, 0); // HEAD 无体
  assert.strictEqual(Number(res.cl), 8);
  srv.stop();
  fs.unlinkSync(tmp);
});
