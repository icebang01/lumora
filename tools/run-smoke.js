// 冒烟测试启动器：用 spawn 启动 electron 并转发全部输出
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const APP_ROOT = path.join(__dirname, '..');
const electron = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDir = APP_ROOT;
const media = process.argv[2] || '';
const extraArgs = process.argv.slice(3);

// --no-sandbox + --disable-gpu-sandbox：managed node 环境下 spawn 的
// electron GPU 进程会因为 sandbox 权限问题崩溃，必须关掉
const args = ['--no-sandbox', '--disable-gpu-sandbox'];

// 独立 --user-data-dir：用户可能正开着播放器（共享默认 profile 会锁 Chromium
// 缓存目录 → 渲染进程起不来、GPU cache 拒绝访问、浏览器进程异常退出 code 0）。
// 用临时目录隔离后，冒烟测试与用户实例互不干扰；退出后清理。
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumora-smoke-'));
args.push(`--user-data-dir=${userData}`);

// 独立 --config-dir：源码运行时 resolveConfigDir 返回仓库 config/（共享！）。
// 不隔离的话，测试写入的 watch_later/续播状态会污染真实配置，且冒烟启动时
// 续播恢复流程可能加载用户最近播的文件、干扰 pendingFile 加载（2026-08 实测）。
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumora-smoke-cfg-'));
args.push(`--config-dir=${configDir}`);

args.push(appDir, '--smoke-test=15');
if (media) args.push(media);
args.push(...extraArgs);

console.log('[launcher] electron:', electron);
console.log('[launcher] args:', JSON.stringify(args));

// 清除 ELECTRON_RUN_AS_NODE，否则 electron.exe 会以纯 Node 模式运行
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

const child = spawn(electron, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (d) => {
  const text = d.toString();
  stdout += text;
  process.stdout.write(d);
});

child.stderr.on('data', (d) => {
  const text = d.toString();
  stderr += text;
  process.stderr.write(d);
});

child.on('close', (code) => {
  console.log('\n[launcher] exit code:', code);
  // 写一份到文件方便后续读取
  const fs = require('fs');
  fs.writeFileSync(path.join(APP_ROOT, 'smoke-result.txt'), stdout + '\n--- STDERR ---\n' + stderr, 'utf8');
  // 清理临时 userData / config-dir
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

child.on('error', (err) => {
  console.error('[launcher] spawn error:', err.message);
});
