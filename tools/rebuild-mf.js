'use strict';
/**
 * 编译 Media Foundation 原生模块（mf_backend.node）。
 *
 * 用法：npm run rebuild-mf
 *
 * 前置要求（仅在 Windows 上需要，且本机验证才用得到）：
 *   - Windows 操作系统（Media Foundation 是 Windows 专属框架）
 *   - Visual Studio 构建工具（含 MSVC C++ 工具集）
 *   - Python 3（node-gyp 依赖）
 *
 * 该模块按 Electron 的 ABI 编译（--runtime=electron），而非 Node 的 ABI，
 * 否则在 Electron 运行时里 require 会因为 NODE_MODULE_VERSION 不匹配而加载失败。
 * Electron 版本从 package.json 的 devDependencies.electron 自动读取。
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function readElectronVersion() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const raw = (pkg.devDependencies && pkg.devDependencies.electron) || '33.0.0';
  // 去掉 ^ ~ > < = 等范围符号，只留纯版本号
  return raw.replace(/[\^~><=\s]/g, '');
}

const electronVer = readElectronVersion();
const nativeDir = path.join(__dirname, '..', 'src', 'main', 'mf', 'native');

const args = [
  'rebuild',
  '--runtime=electron',
  `--target=${electronVer}`,
  '--dist-url=https://electronjs.org/headers',
  `--directory=${nativeDir}`,
];

console.log('[rebuild-mf] 编译 Media Foundation 原生模块');
console.log(`[rebuild-mf]   Electron 版本 : ${electronVer}`);
console.log(`[rebuild-mf]   目标目录     : ${nativeDir}`);
console.log('[rebuild-mf]   前置要求     : Windows + Visual Studio 构建工具 + Python 3');

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npxCmd, ['node-gyp', ...args], { stdio: 'inherit', shell: true });

if (result.error) {
  console.error('[rebuild-mf] 无法启动 node-gyp:', result.error.message);
  process.exit(1);
}
process.exit(result.status || 0);
