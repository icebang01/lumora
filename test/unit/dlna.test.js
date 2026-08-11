'use strict';
// 投屏 DLNA 控制点（block #5）单测：
//  - 纯助手：SSDP 头解析 / 设备描述解析 / SOAP 构造 / SOAP 解析 / DIDL / duration
//  - DlnaDiscovery：注入假 socket，验证 M-SEARCH 发送 + 响应解析事件
//  - DlnaRenderer：注入假 httpRequest，验证各 SOAP 动作的参数与响应解析
const { test } = require('node:test');
const assert = require('node:assert');
const dlna = require('../../src/main/cast/dlna');

/* ---------- SSDP 头解析 ---------- */

test('parseSsdpHeaders：200 OK 响应 + 大小写归一', () => {
  const raw = [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'LOCATION: http://192.168.1.50:8200/desc.xml',
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
    'USN: uuid:abcd::urn:schemas-upnp-org:device:MediaRenderer:1',
    'SERVER: Linux/3.0 UPnP/1.0',
    '',
    '',
  ].join('\r\n');
  const h = dlna.parseSsdpHeaders(raw);
  assert.strictEqual(h._statusCode, 200);
  assert.strictEqual(h.location, 'http://192.168.1.50:8200/desc.xml');
  assert.strictEqual(h.st, 'urn:schemas-upnp-org:device:MediaRenderer:1');
  assert.strictEqual(h.usn, 'uuid:abcd::urn:schemas-upnp-org:device:MediaRenderer:1');
  assert.strictEqual(h['cache-control'], 'max-age=1800');
});

test('parseSsdpHeaders：NOTIFY + \n 换行也能解析', () => {
  const raw = 'NOTIFY * HTTP/1.1\nHOST: 239.255.255.250:1900\nNT: urn:schemas-upnp-org:device:MediaRenderer:1\nUSN: uuid:xyz\n';
  const h = dlna.parseSsdpHeaders(raw);
  assert.strictEqual(h._method, 'NOTIFY');
  assert.strictEqual(h.nt, 'urn:schemas-upnp-org:device:MediaRenderer:1');
});

test('isMediaRenderer：ST / NT 命中 MediaRenderer', () => {
  assert.strictEqual(dlna.isMediaRenderer({ st: 'urn:schemas-upnp-org:device:MediaRenderer:1' }), true);
  assert.strictEqual(dlna.isMediaRenderer({ nt: 'upnp:rootdevice' }), false);
  assert.strictEqual(dlna.isMediaRenderer({ st: 'urn:schemas-upnp-org:service:ContentDirectory:1' }), false);
});

/* ---------- 设备描述解析 ---------- */

const SAMPLE_DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Living Room TV</friendlyName>
    <manufacturer>Samsung</manufacturer>
    <modelName>UA55</modelName>
    <UDN>uuid:renderer-1234</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/AVTransport/control</controlURL>
        <eventSubURL>/AVTransport/event</eventSubURL>
        <SCPDURL>/AVTransport/scpd</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/RenderingControl/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

test('parseDeviceDescription：提取设备信息 + 服务（相对 URL 解析为绝对）', () => {
  const desc = dlna.parseDeviceDescription(SAMPLE_DESC, 'http://192.168.1.50:8200/desc.xml');
  assert.strictEqual(desc.friendlyName, 'Living Room TV');
  assert.strictEqual(desc.manufacturer, 'Samsung');
  assert.strictEqual(desc.modelName, 'UA55');
  assert.strictEqual(desc.udn, 'uuid:renderer-1234');
  assert.strictEqual(desc.services.length, 2);
  const av = desc.services.find((s) => s.type.includes('AVTransport'));
  assert.strictEqual(av.controlURL, 'http://192.168.1.50:8200/AVTransport/control');
  assert.strictEqual(av.eventSubURL, 'http://192.168.1.50:8200/AVTransport/event');
});

test('parseDeviceDescription：无 device 块抛错', () => {
  assert.throws(() => dlna.parseDeviceDescription('<root></root>', 'http://x/'), /no <device>/);
});

/* ---------- SOAP 构造 / 解析 ---------- */

test('buildSoapRequest：信封含服务类型 + 动作 + 转义参数', () => {
  const xml = dlna.buildSoapRequest(dlna.SERVICE.AVTransport, 'SetAVTransportURI', {
    InstanceID: 0, CurrentURI: 'http://x/a&b.mp4', CurrentURIMetaData: '',
  });
  assert.ok(xml.includes('xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"'));
  assert.ok(xml.includes('<u:SetAVTransportURI'));
  assert.ok(xml.includes('http://x/a&amp;b.mp4')); // & 被转义
});

test('parseSoapResponse：提取动作响应参数', () => {
  const xml = `<?xml version="1.0"?>
  <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
    <s:Body>
      <u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
        <CurrentTransportState>PLAYING</CurrentTransportState>
        <CurrentSpeed>1</CurrentSpeed>
      </u:GetTransportInfoResponse>
    </s:Body>
  </s:Envelope>`;
  const { action, args } = dlna.parseSoapResponse(xml);
  assert.strictEqual(action, 'GetTransportInfoResponse');
  assert.strictEqual(args.CurrentTransportState, 'PLAYING');
  assert.strictEqual(args.CurrentSpeed, '1');
});

test('parseSoapResponse：SOAP fault 抛 DlnaSoapError', () => {
  const xml = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
    <s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Invalid Args</faultstring></s:Fault></s:Body></s:Envelope>`;
  assert.throws(() => dlna.parseSoapResponse(xml), dlna.DlnaSoapError);
});

/* ---------- DIDL / duration ---------- */

test('buildDidl + formatDuration：生成元数据并格式化时长', () => {
  const didl = dlna.buildDidl('http://x/v.mp4', { title: 'My <Movie>', duration: 3661.5, resolution: '1920x1080' });
  assert.ok(didl.includes('object.item.videoItem'));
  assert.ok(didl.includes('protocolInfo="http-get:*:video/mp4:*"'));
  assert.ok(didl.includes('My &lt;Movie&gt;'));
  assert.ok(didl.includes('duration="1:01:01.500"'));
  assert.ok(didl.includes('resolution="1920x1080"'));
});

test('parseDuration：DIDL 时长 → 秒', () => {
  assert.strictEqual(dlna.parseDuration('1:01:01.500'), 3661.5);
  assert.strictEqual(dlna.parseDuration('0:00:30.000'), 30);
  assert.strictEqual(dlna.parseDuration(''), 0);
});

/* ---------- DlnaDiscovery（注入假 socket） ---------- */

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

test('DlnaDiscovery：start 发 M-SEARCH，message 触发 response 事件', async () => {
  const fake = makeFakeSocket();
  const disc = new dlna.DlnaDiscovery({ createSocket: () => fake, searchTimeout: 100 });
  const got = [];
  disc.on('response', (r) => got.push(r));
  await disc.start();

  // bind 触发 listening → 应发出 M-SEARCH
  assert.ok(fake._lastSend && fake._lastSend.includes('M-SEARCH * HTTP/1.1'));
  assert.ok(fake._lastSend.includes('ST: urn:schemas-upnp-org:device:MediaRenderer:1'));

  // 模拟收到一条 SSDP 响应
  const ssdp = [
    'HTTP/1.1 200 OK',
    'LOCATION: http://192.168.1.50:8200/desc.xml',
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
    'USN: uuid:abc',
    '',
  ].join('\r\n');
  fake.emit('message', Buffer.from(ssdp), { address: '192.168.1.50', port: 1900 });

  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].headers.location, 'http://192.168.1.50:8200/desc.xml');
  assert.strictEqual(got[0].address, '192.168.1.50');

  disc.stop();
  assert.strictEqual(disc.socket, null);
});

test('DlnaDiscovery：无 LOCATION 的报文被忽略', async () => {
  const fake = makeFakeSocket();
  const disc = new dlna.DlnaDiscovery({ createSocket: () => fake });
  let n = 0;
  disc.on('response', () => n++);
  await disc.start();
  fake.emit('message', Buffer.from('HTTP/1.1 200 OK\nCACHE-CONTROL: max-age=1\n\n'), {});
  assert.strictEqual(n, 0);
  disc.stop();
});

/* ---------- DlnaRenderer（注入假 httpRequest） ---------- */

function makeFakeHttp(calls) {
  return async (url, opts) => {
    const soapAction = (opts.headers.SOAPACTION || '').replace(/"/g, '').split('#')[1] || '';
    if (calls) calls.push({ url, soapAction, body: opts.body, args: extractArgs(opts.body) });
    const body = buildFakeResponse(soapAction);
    return { statusCode: 200, headers: {}, body };
  };
}
function extractArgs(xml) {
  // 从 SOAP 请求体抽出子元素键值（测试断言用）
  const out = {};
  const re = /<([\w-]+)>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out[m[1]] = m[2];
  return out;
}
function buildFakeResponse(action) {
  const map = {
    GetTransportInfo: '<CurrentTransportState>PLAYING</CurrentTransportState><CurrentSpeed>1</CurrentSpeed>',
    GetPositionInfo: '<RelTime>0:00:10.000</RelTime><TrackDuration>0:01:00.000</TrackDuration><TrackURI>http://x/v.mp4</TrackURI>',
  };
  const inner = map[action] || '';
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${inner}</u:${action}Response></s:Body></s:Envelope>`;
}

const RENDERER_DESC = {
  friendlyName: 'Test TV',
  services: [
    { type: dlna.SERVICE.AVTransport, controlURL: 'http://tv:8200/AVTransport/control' },
    { type: dlna.SERVICE.RenderingControl, controlURL: 'http://tv:8200/RenderingControl/control' },
  ],
};

test('DlnaRenderer：play/pause/stop/seek/setVolume 参数正确', async () => {
  const calls = [];
  const r = new dlna.DlnaRenderer({ device: RENDERER_DESC, httpRequest: makeFakeHttp(calls) });
  await r.play(1);
  await r.pause();
  await r.stop();
  await r.seek(42);
  await r.setVolume(55);

  const byAction = Object.fromEntries(calls.map((c) => [c.soapAction, c]));
  assert.strictEqual(byAction.Play.args.Speed, '1');
  assert.strictEqual(byAction.Seek.args.Unit, 'ABS_TIME');
  assert.strictEqual(byAction.Seek.args.Target, '0:00:42.000');
  assert.strictEqual(byAction.SetVolume.args.DesiredVolume, '55');
  assert.strictEqual(byAction.SetVolume.args.Channel, 'Master');
  // 控制 URL 路由正确：音量走 RenderingControl
  assert.ok(byAction.SetVolume.url.includes('/RenderingControl/'));
  assert.ok(byAction.Play.url.includes('/AVTransport/'));
});

test('DlnaRenderer：setAvUri 注入 DIDL 元数据', async () => {
  const calls = [];
  const r = new dlna.DlnaRenderer({ device: RENDERER_DESC, httpRequest: makeFakeHttp(calls) });
  await r.setAvUri('http://192.168.1.2:9999/cast', { title: 'Clip', duration: 120 });
  const c = calls.find((x) => x.soapAction === 'SetAVTransportURI');
  assert.ok(c);
  assert.ok(c.args.CurrentURI.includes('http://192.168.1.2:9999/cast'));
  assert.ok(c.args.CurrentURIMetaData.includes('object.item.videoItem'));
  assert.ok(c.args.CurrentURIMetaData.includes('Clip'));
});

test('DlnaRenderer：getTransportInfo / getPositionInfo 解析', async () => {
  const r = new dlna.DlnaRenderer({ device: RENDERER_DESC, httpRequest: makeFakeHttp() });
  const ti = await r.getTransportInfo();
  assert.strictEqual(ti.state, 'PLAYING');
  const pi = await r.getPositionInfo();
  assert.strictEqual(pi.positionSeconds, 10);
  assert.strictEqual(pi.durationSeconds, 60);
});

test('DlnaRenderer：缺少服务时 _controlUrl 返回 null，_soap 抛错', () => {
  const r = new dlna.DlnaRenderer({ device: { services: [] } });
  assert.strictEqual(r._controlUrl(dlna.SERVICE.AVTransport), null);
  return assert.rejects(() => r._soap(dlna.SERVICE.AVTransport, 'Play', {}), /service not available/);
});
