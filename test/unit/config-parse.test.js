'use strict';
// config.js 纯解析函数单测：parseInputConf（input.conf 语法）与 parseArgv（CLI 参数）。
const { test } = require('node:test');
const assert = require('node:assert');
const { parseInputConf, parseArgv } = require('../../src/main/config');

test('parseInputConf：注释/空行跳过，key+command+args 解析', () => {
  const binds = parseInputConf('# 注释\n\nLEFT seek -5\nwheel_up volume 2\n');
  assert.equal(binds.length, 2);
  assert.deepEqual(binds[0], { key: 'LEFT', command: 'seek', args: ['-5'], raw: 'LEFT seek -5' });
  assert.deepEqual(binds[1], { key: 'wheel_up', command: 'volume', args: ['2'], raw: 'wheel_up volume 2' });
});

test('parseInputConf：引号键原样保留（characterization）', () => {
  const binds = parseInputConf('"ctrl+right" seek 5\n');
  assert.equal(binds[0].key, '"ctrl+right"');
  assert.equal(binds[0].command, 'seek');
  assert.deepEqual(binds[0].args, ['5']);
});

test('parseInputConf：仅键无命令的行跳过', () => {
  const binds = parseInputConf('LEFT\nRIGHT seek 1\n');
  assert.equal(binds.length, 1);
  assert.equal(binds[0].key, 'RIGHT');
});

test('parseArgv：--key=value / 开关 / --no-取反 / 位置参数', () => {
  const { options, files } = parseArgv(['--hwdec=cuda', '--dev', '--no-hardware', 'C:/a.mp4', 'b.mkv']);
  assert.equal(options.hwdec, 'cuda');
  assert.equal(options.dev, true);
  assert.equal(options.hardware, false);
  assert.deepEqual(files, ['C:/a.mp4', 'b.mkv']);
});
