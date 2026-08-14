'use strict';
// 投屏 DIAL 客户端（v2 = +DIAL）单测：
//  - 纯助手：isDialDevice / parseDialAppStatus / buildDialLaunch / dialInstanceHref
//  - DialDiscovery：注入假 socket，验证 M-SEARCH 发送 DIAL ST + 响应解析事件
//  - DialClient：注入假 httpRequest，验证启动(POST)/停止(DELETE)/状态查询/不支持的操作
const { test } = require('node:test');
const assert = require('node:assert');
const dial = require('../../src/main/cast/dial');

/* ---------- 纯助手 ---------- */

test('isDialDevice：ST / NT 命中 dial-multiscreen', () => {
  assert.strictEqual(dial.isDialDevice({ st: 'urn:dial-multiscreen-org:service:dial:1' }), true);
  assert.strictEqual(dial.isDialDevice({ nt: 'urn:dial-multiscreen-org:service:dial:1' }), true);
  assert.strictEqual(dial.isDialDevice({ st: 'urn:schemas-upnp-org:device:MediaRenderer:1' }), false);
  assert.strictEqual(dial.isDialDevice({ nt: 'upnp:rootdevice' }), false);
});

test('parseDialAppStatus：running + 提取实例 href', () => {
  const xml = `<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="1.7">
    <name>YouTube</name>
    <state>running</state>
    <link rel="run" href="http://tv:8001/apps/YouTube/run/1234"/>
  </service>`;
  const s = dial.parseDialAppStatus(xml, 200);
  assert.strictEqual(s.installed, true);
  assert.strictEqual(s.state, 'running');
  assert.strictEqual(s.instanceUrl, 'http://tv:8001/apps/YouTube/run/1234');
});

test('parseDialAppStatus：hidden 状态', () => {
  const xml = '<service xmlns="x"><name>YouTube</name><state>hidden</state></service>';
  const s = dial.parseDialAppStatus(xml, 200);
  assert.strictEqual(s.state, 'hidden');
  assert.strictEqual(s.instanceUrl, '');
});

test('parseDialAppStatus：404 = 未安装', () => {
  const s = dial.parseDialAppStatus('', 404);
  assert.strictEqual(s.installed, false);
  assert.strictEqual(s.state, 'not_installed');
});

test('dialInstanceHref：href 在 rel 之前或之后都能解析', () => {
  assert.strictEqual(
    dial.dialInstanceHref('<link rel="run" href="http://a/1"/>'),
    'http://a/1');
  assert.strictEqual(
    dial.dialInstanceHref('<link href="http://b/2" rel="run"/>'),
    'http://b/2');
});

test('buildDialLaunch：含 App 名 + URL（转义）', () => {
  const body = dial.buildDialLaunch('YouTube', 'http://x/v?a=1&b=2');
  assert.ok(body.includes('xmlns="urn:dial-multiscreen-org:schemas:dial"'));
  assert.ok(body.includes('<name>YouTube</name>'));
  assert.ok(body.includes('<url>http://x/v?a=1&amp;b=2</url>')); // & 被转义
});

/* ---------- DialDiscovery（注入假 socket） ---------- */

function makeFakeSocket() {
  const handlers = {};
  const sock = {
    _handlers: handlers,
    _lastSend: null,
    on(ev, cb) { handlers[ev] = cb; return sock; },
    send(buf, off, len, port, addr, cb) { sock._lastSend = buf.toString('utf8'); if (cb) cb(null); },
    bind() { if (handlers.listening) handlers.listening(); },
    addMembership() {},
    dropMembership() {},
    close() { if (handlers.close) handlers.close(); },
    emit(ev, ...a) { if (handlers[ev]) handlers[ev](...a); },
  };
  return sock;
}

test('DialDiscovery：start 发 M-SEARCH，ST 为 DIAL 服务', async () => {
  const fake = makeFakeSocket();
  const disc = new dial.DialDiscovery({ createSocket: () => fake, searchTimeout: 100 });
  const got = [];
  disc.on('response', (r) => got.push(r));
  await disc.start();

  assert.ok(fake._lastSend && fake._lastSend.includes('M-SEARCH * HTTP/1.1'));
  assert.ok(fake._lastSend.includes(`ST: ${dial.DIAL_ST}`));

  disc.stop();
  assert.strictEqual(disc.socket, null);
});

test('DialDiscovery：收到带 LOCATION 的 SSDP 响应 → 触发 response 事件', async () => {
  const fake = makeFakeSocket();
  const disc = new dial.DialDiscovery({ createSocket: () => fake });
  const got = [];
  disc.on('response', (r) => got.push(r));
  await disc.start();
  const ssdp = [
    'HTTP/1.1 200 OK',
    'LOCATION: http://192.168.1.60:8001/dd.xml',
    'ST: urn:dial-multiscreen-org:service:dial:1',
    'USN: uuid:dial-999::urn:dial-multiscreen-org:service:dial:1',
    '',
  ].join('\r\n');
  fake.emit('message', Buffer.from(ssdp), { address: '192.168.1.60', port: 1900 });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].headers.location, 'http://192.168.1.60:8001/dd.xml');
  assert.strictEqual(got[0].address, '192.168.1.60');
  disc.stop();
});

/* ---------- DialClient（注入假 httpRequest） ---------- */

function makeDialHttp() {
  // 应用基址 http://tv:8001/apps/ ，App 名 YouTube
  // GET  /apps/YouTube     → running 状态 + 实例 href
  // POST /apps/YouTube     → 201 + LOCATION 实例
  // DELETE 实例            → 200
  const calls = [];
  return {
    calls,
    request: async (url, opts) => {
      calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
      if (opts.method === 'GET' && /\/apps\/YouTube$/.test(url)) {
        return {
          statusCode: 200, headers: {},
          body: '<service xmlns="x"><name>YouTube</name><state>running</state>' +
            '<link rel="run" href="http://tv:8001/apps/YouTube/run/1234"/></service>',
        };
      }
      if (opts.method === 'POST' && /\/apps\/YouTube$/.test(url)) {
        return { statusCode: 201, headers: { location: 'http://tv:8001/apps/YouTube/run/1234' }, body: '' };
      }
      if (opts.method === 'DELETE' && url === 'http://tv:8001/apps/YouTube/run/1234') {
        return { statusCode: 200, headers: {}, body: '' };
      }
      return { statusCode: 404, headers: {}, body: '' };
    },
  };
}

test('DialClient：setAvUri + play 发起 POST 启动，记录实例 URL', async () => {
  const h = makeDialHttp();
  const c = new dial.DialClient({ device: { dialServiceUrl: 'http://tv:8001/apps/' }, appName: 'YouTube', httpRequest: h.request });
  await c.setAvUri('http://example.com/v.mp4', { title: 'Clip' });
  const r = await c.play(1);

  const post = h.calls.find((x) => x.method === 'POST');
  assert.ok(post, '应有一次 POST');
  assert.strictEqual(post.url, 'http://tv:8001/apps/YouTube');
  assert.strictEqual(post.headers['Content-Type'], 'application/dial+xml');
  assert.ok(post.body.includes('<name>YouTube</name>'));
  assert.ok(post.body.includes('http://example.com/v.mp4'));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(c._instanceUrl, 'http://tv:8001/apps/YouTube/run/1234');
});

test('DialClient：play 无待播 URL 抛错', async () => {
  const h = makeDialHttp();
  const c = new dial.DialClient({ device: { dialServiceUrl: 'http://tv:8001/apps/' }, httpRequest: h.request });
  await assert.rejects(() => c.play(1), /无待播 URL/);
});

test('DialClient：play 遇 404 抛"未安装"', async () => {
  const h = makeDialHttp();
  // 覆盖 POST 返回 404（App 未安装）
  const c = new dial.DialClient({
    device: { dialServiceUrl: 'http://tv:8001/apps/' },
    httpRequest: async (url, opts) => {
      if (opts.method === 'POST') return { statusCode: 404, headers: {}, body: '' };
      return { statusCode: 200, headers: {}, body: '' };
    },
  });
  await c.setAvUri('http://x/v.mp4');
  await assert.rejects(() => c.play(1), /未安装/);
});

test('DialClient：stop 对实例发 DELETE', async () => {
  const h = makeDialHttp();
  const c = new dial.DialClient({ device: { dialServiceUrl: 'http://tv:8001/apps/' }, httpRequest: h.request });
  await c.setAvUri('http://x/v.mp4');
  await c.play(1);
  h.calls.length = 0;
  await c.stop();
  const del = h.calls.find((x) => x.method === 'DELETE');
  assert.ok(del, '应有一次 DELETE');
  assert.strictEqual(del.url, 'http://tv:8001/apps/YouTube/run/1234');
  assert.strictEqual(c._instanceUrl, '');
});

test('DialClient：getTransportInfo 反映 App running → PLAYING', async () => {
  const h = makeDialHttp();
  const c = new dial.DialClient({ device: { dialServiceUrl: 'http://tv:8001/apps/' }, httpRequest: h.request });
  const ti = await c.getTransportInfo();
  assert.strictEqual(ti.state, 'PLAYING');
});

test('DialClient：pause/resume/seek/setVolume 明确不支持', async () => {
  const h = makeDialHttp();
  const c = new dial.DialClient({ device: { dialServiceUrl: 'http://tv:8001/apps/' }, httpRequest: h.request });
  await assert.rejects(() => c.pause(), /不支持/);
  await assert.rejects(() => c.resume(), /不支持/);
  await assert.rejects(() => c.seek(10), /不支持/);
  await assert.rejects(() => c.setVolume(50), /不支持/);
});

test('DialClient：缺少 dialServiceUrl 构造即抛错', () => {
  assert.throws(() => new dial.DialClient({ device: {} }), /DIAL 服务地址缺失/);
});
