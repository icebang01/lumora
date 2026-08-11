'use strict';
/**
 * Chromecast 投屏模块单测（纯助手 + 注入式发现 + 鉴权签名）。
 * 不依赖真实网络 / Chromecast 设备：发现用假 mDNS，鉴权用本地生成的 RSA 密钥对。
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const cc = require('../../src/main/cast/chromecast');
const {
  parseTxtRecords, frameCastMessage, CastMessageParser,
  buildMediaLoad, buildReceiverLaunch, ChromecastDiscovery, ChromecastClient,
} = cc;

/* -------------------------------------------------- */
/* parseTxtRecords                                    */
/* -------------------------------------------------- */

function txtBufferFrom(obj) {
  let buf = Buffer.alloc(0);
  for (const [k, v] of Object.entries(obj)) {
    const chunk = Buffer.from(`${k}=${v}`, 'utf8');
    buf = Buffer.concat([buf, Buffer.from([chunk.length]), chunk]);
  }
  return buf;
}

test('parseTxtRecords 解析单 Buffer TXT 记录', () => {
  const txt = txtBufferFrom({ id: 'ABC123', fn: 'Living Room', md: 'Chromecast', rs: 'ready', ca: '1', ve: '1.56' });
  const r = parseTxtRecords(txt);
  assert.strictEqual(r.id, 'ABC123');
  assert.strictEqual(r.friendlyName, 'Living Room');
  assert.strictEqual(r.model, 'Chromecast');
  assert.strictEqual(r.state, 'ready');
  assert.strictEqual(r.authRequired, true);
  assert.strictEqual(r.version, '1.56');
});

test('parseTxtRecords 接受已解析对象（直接复用）', () => {
  const r = parseTxtRecords({ id: 'X', fn: 'Kitchen', rs: 'stopped' });
  assert.strictEqual(r.friendlyName, 'Kitchen');
  assert.strictEqual(r.state, 'stopped');
});

test('parseTxtRecords 接受 Buffer 数组（multicast-dns 默认形态）', () => {
  const a = txtBufferFrom({ id: 'ZZ' });
  const b = txtBufferFrom({ fn: 'Bedroom' });
  const r = parseTxtRecords([a, b]);
  assert.strictEqual(r.id, 'ZZ');
  assert.strictEqual(r.friendlyName, 'Bedroom');
});

/* -------------------------------------------------- */
/* 帧编解码                                            */
/* -------------------------------------------------- */

test('frameCastMessage + CastMessageParser 往返一致', () => {
  const msg = {
    protocolVersion: 0,
    sourceId: 'sender-0',
    destinationId: 'receiver-0',
    namespace: 'urn:x-cast:com.google.cast.tp.connection',
    payloadType: 0,
    payloadUtf8: JSON.stringify({ type: 'CONNECT' }),
  };
  const frame = frameCastMessage(msg);
  // 帧头 2 字节大端长度
  assert.strictEqual(frame.readUInt16BE(0), frame.length - 2);
  const parser = new CastMessageParser();
  let out = null;
  parser.push(frame, (m) => { out = m; });
  assert.deepStrictEqual(out, msg);
});

test('CastMessageParser 处理跨包拆分', () => {
  const msg = { namespace: 'x', payloadUtf8: '{"type":"PING"}' };
  const frame = frameCastMessage(msg);
  const parser = new CastMessageParser();
  const got = [];
  parser.push(frame.subarray(0, 3), (m) => got.push(m));
  parser.push(frame.subarray(3), (m) => got.push(m));
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(got[0], msg);
});

/* -------------------------------------------------- */
/* 载荷构造                                            */
/* -------------------------------------------------- */

test('buildMediaLoad 默认结构 + 字幕轨', () => {
  const load = buildMediaLoad({
    contentId: 'http://h/1.mp4', contentType: 'video/mp4', title: 'Movie',
    subtitles: [{ url: 'http://h/1.vtt', name: '中', lang: 'zh', contentType: 'text/vtt' }],
  });
  assert.strictEqual(load.type, 'LOAD');
  assert.strictEqual(load.media.contentId, 'http://h/1.mp4');
  assert.strictEqual(load.media.streamType, 'BUFFERED');
  assert.strictEqual(load.media.autoplay, true);
  assert.strictEqual(load.media.metadata.title, 'Movie');
  assert.strictEqual(load.media.textTracks.length, 1);
  assert.strictEqual(load.media.textTracks[0].trackContentId, 'http://h/1.vtt');
  assert.strictEqual(load.media.textTracks[0].subtype, 'SUBTITLES');
});

test('buildMediaLoad autoplay=false 时生效', () => {
  const load = buildMediaLoad({ contentId: 'u', autoplay: false });
  assert.strictEqual(load.media.autoplay, false);
});

test('buildReceiverLaunch 带 appId', () => {
  const l = buildReceiverLaunch('CC1AD845', 7);
  assert.strictEqual(l.type, 'LAUNCH');
  assert.strictEqual(l.appId, 'CC1AD845');
  assert.strictEqual(l.requestId, 7);
});

/* -------------------------------------------------- */
/* ChromecastDiscovery（注入假 mDNS）                  */
/* -------------------------------------------------- */

test('ChromecastDiscovery 从假 mDNS 响应吐出 device 事件', async () => {
  const fakeMdns = new EventEmitter();
  fakeMdns.query = () => {};
  fakeMdns.destroy = () => {};
  const d = new ChromecastDiscovery({ createMdns: () => fakeMdns, searchTimeout: 200 });
  const devices = [];
  d.on('device', (dev) => devices.push(dev));
  await d.start();
  const txt = txtBufferFrom({ id: 'DEADBEEF', fn: 'Living Room', md: 'Chromecast', rs: 'ready', ca: '0' });
  fakeMdns.emit('response',
    { answers: [{ name: '_googlecast._tcp.local', type: 'TXT', data: [txt] }] },
    { address: '192.168.1.50' });
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].type, 'chromecast');
  assert.strictEqual(devices[0].id, 'DEADBEEF');
  assert.strictEqual(devices[0].friendlyName, 'Living Room');
  assert.strictEqual(devices[0].address, '192.168.1.50');
  assert.strictEqual(devices[0].port, 8009);
  d.stop();
});

test('ChromecastDiscovery 忽略非 _googlecast 答案 + 去重', async () => {
  const fakeMdns = new EventEmitter();
  fakeMdns.query = () => {};
  fakeMdns.destroy = () => {};
  const d = new ChromecastDiscovery({ createMdns: () => fakeMdns, searchTimeout: 200 });
  const devices = [];
  d.on('device', (dev) => devices.push(dev));
  await d.start();
  const txt = txtBufferFrom({ id: 'SAME', fn: 'TV', rs: 'ready' });
  const ans = { name: '_googlecast._tcp.local', type: 'TXT', data: [txt] };
  fakeMdns.emit('response', { answers: [ans] }, { address: '10.0.0.2' });
  fakeMdns.emit('response', { answers: [ans] }, { address: '10.0.0.2' }); // 重复
  fakeMdns.emit('response', { answers: [{ name: '_other._tcp.local', type: 'TXT', data: [txt] }] }, { address: '10.0.0.3' });
  assert.strictEqual(devices.length, 1);
  d.stop();
});

/* -------------------------------------------------- */
/* 鉴权签名（本地 RSA 密钥对，真实 crypto）            */
/* -------------------------------------------------- */

test('ChromecastClient._respondAuth 产出可被公钥验证的 RSA-SHA256 签名', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  // 假的证书 PEM（仅用于验证 pemToDerBase64 不报错，签名用私钥）
  const fakeCert = '-----BEGIN CERTIFICATE-----\n' + Buffer.from('fake-cert').toString('base64') + '\n-----END CERTIFICATE-----';
  const salt = crypto.randomBytes(16).toString('base64');
  const client = new ChromecastClient({
    address: '127.0.0.1',
    authCertificate: fakeCert,
    authKey: privPem,
    authSalt: salt,
  });
  const challenge = crypto.randomBytes(32).toString('base64');
  const resp = client._respondAuth(challenge);
  assert.strictEqual(resp.type, 'DEVICE_AUTH_CHALLENGE_RESPONSE');
  // 用公钥验证签名 = RSA-SHA256( challenge || salt )
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(Buffer.concat([Buffer.from(challenge, 'base64'), Buffer.from(salt, 'base64')]));
  assert.ok(verifier.verify(pubPem, Buffer.from(resp.data.signature, 'base64')), '签名应可被公钥验证');
  // clientAuthCertificate 应是 DER 的 base64
  assert.strictEqual(resp.data.clientAuthCertificate, Buffer.from('fake-cert').toString('base64'));
});

test('ChromecastClient 缺 address 构造抛错', () => {
  assert.throws(() => new ChromecastClient({}), /address/);
});
