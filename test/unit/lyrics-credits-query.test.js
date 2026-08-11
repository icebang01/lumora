'use strict';
// 词曲编曲在线查询（MusicBrainz + 网易云音乐 fallback）解析与降级测试
const assert = require('assert');
const { test } = require('node:test');
const { EventEmitter } = require('events');
const https = require('https');

const { extractCreditsFromWork, queryCredits, queryNeteaseCredits } = require('../../src/main/ffmpeg/lyrics');

// 复刻 MusicBrainz work + artist-rels 真实结构（周杰伦《借口》）
const SAMPLE_WORK = {
  id: 'bec8c68e-f127-31aa-92c1-d616e8940f7d',
  title: '藉口',
  score: 100,
  relations: [
    { type: 'lyricist', artist: { name: '周杰倫' } },
    { type: 'composer', artist: { name: '周杰倫' } },
    { type: 'performance', recording: { title: '藉口' } },
  ],
};

function fakeHttps(jsonBody, statusCode = 200) {
  const orig = https.get;
  https.get = (url, opts, cb) => {
    const cbFn = typeof opts === 'function' ? opts : cb;
    const res = new EventEmitter();
    res.statusCode = statusCode;
    process.nextTick(() => {
      res.emit('data', JSON.stringify(jsonBody));
      res.emit('end');
    });
    cbFn(res);
    return { on() {}, destroy() {} };
  };
  return () => { https.get = orig; };
}

function fakeHttpsRouter(routes) {
  const orig = https.get;
  https.get = (url, opts, cb) => {
    const urlStr = url instanceof URL ? url.href : String(url);
    const route = routes.find((r) => urlStr.includes(r.match));
    const body = route && route.body != null ? route.body : {};
    const status = route && route.status != null ? route.status : 200;
    const cbFn = typeof opts === 'function' ? opts : cb;
    const res = new EventEmitter();
    res.statusCode = status;
    process.nextTick(() => {
      res.emit('data', JSON.stringify(body));
      res.emit('end');
    });
    cbFn(res);
    return { on() {}, destroy() {} };
  };
  return () => { https.get = orig; };
}

const NETEASE_SEARCH = {
  result: {
    songs: [
      { id: 123, name: '桃花诺', artists: [{ name: 'G.E.M.邓紫棋' }], duration: 219000 },
      { id: 456, name: '桃花诺 (Live版)', artists: [{ name: '罗云熙' }, { name: '黄霄雲' }], duration: 264000 },
    ],
  },
};

const NETEASE_LYRIC = {
  lrc: {
    lyric: `[00:00.00] 作词 : 张赢
[00:00.50] 作曲 : 罗锟
[00:01.00] 编曲 : 罗锟/陈雪燃
[00:01.50] 制作人 : 张赢/陈雪燃
[00:03.05] 和音：赵贝尔
[00:19.71]初见若缱绻`,
  },
};

test('extractCreditsFromWork 解析 lyricist/composer，忽略非作者关系', () => {
  const c = extractCreditsFromWork(SAMPLE_WORK);
  assert.equal(c.lyricist, '周杰伦'); // 繁→简
  assert.equal(c.composer, '周杰伦');
  assert.equal(c.arranger, ''); // performance 关系不提取
});

test('extractCreditsFromWork 处理空/无 relations', () => {
  assert.deepEqual(extractCreditsFromWork({ relations: [] }), { lyricist: '', composer: '', arranger: '' });
  assert.deepEqual(extractCreditsFromWork(null), { lyricist: '', composer: '', arranger: '' });
});

test('extractCreditsFromWork 解析 arranger', () => {
  const c = extractCreditsFromWork({ relations: [{ type: 'arranger', artist: { name: '洪敬堯' } }] });
  assert.equal(c.arranger, '洪敬尧');
});

test('queryCredits 命中 MB work 返回词曲', async () => {
  const restore = fakeHttps({ works: [SAMPLE_WORK] });
  try {
    const r = await queryCredits('借口', '周杰伦');
    assert.equal(r.ok, true);
    assert.equal(r.lyricist, '周杰伦');
    assert.equal(r.composer, '周杰伦');
  } finally {
    restore();
  }
});

test('queryCredits 无 work 结果时安全降级为 ok:false', async () => {
  const restore = fakeHttps({ works: [] });
  try {
    const r = await queryCredits('某不存在的歌', '某歌手');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  } finally {
    restore();
  }
});

test('queryCredits 无 metadata 直接降级', async () => {
  const r = await queryCredits('', '');
  assert.equal(r.ok, false);
});

test('queryCredits 网络错误（status!=2xx）降级为 ok:false', async () => {
  const restore = fakeHttps({ error: 'nope' }, 503);
  try {
    const r = await queryCredits('借口', '周杰伦');
    assert.equal(r.ok, false);
  } finally {
    restore();
  }
});

test('queryNeteaseCredits 命中歌曲并提取 credits', async () => {
  const restore = fakeHttpsRouter([
    { match: '/api/search/get/web', body: NETEASE_SEARCH },
    { match: '/api/song/lyric', body: NETEASE_LYRIC },
  ]);
  try {
    const r = await queryNeteaseCredits('桃花诺', 'G.E.M.邓紫棋');
    assert.equal(r.ok, true);
    assert.equal(r.lyricist, '张赢');
    assert.equal(r.composer, '罗锟');
    assert.equal(r.arranger, '罗锟/陈雪燃');
    assert.equal(r.producer, '张赢/陈雪燃');
    assert.equal(r.backing, '赵贝尔');
  } finally {
    restore();
  }
});

test('queryNeteaseCredits 歌词无 credits 时降级', async () => {
  const restore = fakeHttpsRouter([
    { match: '/api/search/get/web', body: NETEASE_SEARCH },
    { match: '/api/song/lyric', body: { lrc: { lyric: '[00:00.00]无信息\n[00:01.00]你好' } } },
  ]);
  try {
    const r = await queryNeteaseCredits('桃花诺', 'G.E.M.邓紫棋');
    assert.equal(r.ok, false);
  } finally {
    restore();
  }
});

test('queryCredits MusicBrainz 无结果时回退网易云音乐', async () => {
  const restore = fakeHttpsRouter([
    { match: 'musicbrainz.org/ws/2/work', body: { works: [] } },
    { match: '/api/search/get/web', body: NETEASE_SEARCH },
    { match: '/api/song/lyric', body: NETEASE_LYRIC },
  ]);
  try {
    const r = await queryCredits('桃花诺', 'G.E.M.邓紫棋');
    assert.equal(r.ok, true);
    assert.equal(r.lyricist, '张赢');
    assert.equal(r.composer, '罗锟');
    assert.equal(r.arranger, '罗锟/陈雪燃');
  } finally {
    restore();
  }
});
