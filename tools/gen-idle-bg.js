// 生成 idle 科技线条背景的 base64 data URI（供 src/renderer/style.css 使用）。
// 如果需要调整曲线/光环/动画，直接修改下面的 svg 字符串后重新运行本脚本即可。
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="techStroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6ee7ff"/>
      <stop offset="55%" stop-color="#8b7bff"/>
      <stop offset="100%" stop-color="#ff7ac6"/>
    </linearGradient>
    <filter id="techGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <style>
    @keyframes apro { to { transform: rotate(360deg); } }
    @keyframes apri { to { transform: rotate(-360deg); } }
    @keyframes app { 0%,100% { opacity: .12; transform: scale(1); } 50% { opacity: .28; transform: scale(1.04); } }
    @keyframes app2 { 0%,100% { opacity: .07; } 50% { opacity: .20; } }
    @keyframes apc { 0%,100% { opacity: .25; transform: scale(1); } 50% { opacity: .55; transform: scale(1.35); } }
    .ap-outer,.ap-inner,.ap-bl-outer,.ap-bl-inner,.ap-pulse,.ap-pulse2,.ap-core { transform-box: fill-box; transform-origin: center; }
    .ap-outer { animation: apro 48s linear infinite; }
    .ap-inner { animation: apri 32s linear infinite; }
    .ap-bl-outer { animation: apro 56s linear infinite reverse; }
    .ap-bl-inner { animation: apri 38s linear infinite; }
    .ap-pulse { animation: app 5.5s ease-in-out infinite; }
    .ap-pulse2 { animation: app2 4.2s ease-in-out infinite; }
    .ap-core { animation: apc 3.6s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce) {
      .ap-outer,.ap-inner,.ap-bl-outer,.ap-bl-inner,.ap-pulse,.ap-pulse2,.ap-core { animation: none; }
    }
  </style>
  <g filter="url(#techGlow)" fill="none" stroke="url(#techStroke)" stroke-linecap="round">
    <path d="M-120 720 C 420 600, 760 200, 1740 110" stroke-width="1.4" opacity="0.22"/>
    <path d="M-120 850 C 520 780, 980 430, 1740 360" stroke-width="1" opacity="0.13"/>
    <path d="M160 -60 C 380 260, 620 520, 940 960" stroke-width="1" opacity="0.12"/>
    <path d="M1180 -60 C 980 280, 820 560, 560 960" stroke-width="0.8" opacity="0.10"/>
  </g>
  <g filter="url(#techGlow)" fill="none" stroke="url(#techStroke)" stroke-linecap="round">
    <!-- 右上角光圈：慢速顺时针旋转 + 呼吸缩放 -->
    <g transform="translate(1360,150)">
      <g class="ap-outer">
        <circle cx="0" cy="0" r="280" stroke-width="1.4" stroke-dasharray="96 32 64 24" class="ap-pulse"/>
        <circle cx="0" cy="0" r="252" stroke-width="0.8" opacity="0.10" stroke-dasharray="32 56 24 80"/>
      </g>
      <g class="ap-inner">
        <circle cx="0" cy="0" r="200" stroke-width="1" stroke-dasharray="64 40 56 32" class="ap-pulse2"/>
        <circle cx="0" cy="0" r="176" stroke-width="0.6" opacity="0.09" stroke-dasharray="22 44 22 48"/>
      </g>
      <circle cx="0" cy="0" r="5" fill="url(#techStroke)" class="ap-core" stroke="none"/>
    </g>
    <!-- 左下角光圈：尺寸小一半，反向/变速旋转，保持同风格 -->
    <g transform="translate(220,760) scale(0.5)">
      <g class="ap-bl-outer">
        <circle cx="0" cy="0" r="280" stroke-width="1.4" stroke-dasharray="96 32 64 24" class="ap-pulse"/>
        <circle cx="0" cy="0" r="252" stroke-width="0.8" opacity="0.10" stroke-dasharray="32 56 24 80"/>
      </g>
      <g class="ap-bl-inner">
        <circle cx="0" cy="0" r="200" stroke-width="1" stroke-dasharray="64 40 56 32" class="ap-pulse2"/>
        <circle cx="0" cy="0" r="176" stroke-width="0.6" opacity="0.09" stroke-dasharray="22 44 22 48"/>
      </g>
      <circle cx="0" cy="0" r="5" fill="url(#techStroke)" class="ap-core" stroke="none"/>
    </g>
  </g>
</svg>`;

const base64 = Buffer.from(svg).toString('base64');
const dataUri = `url("data:image/svg+xml;base64,${base64}")`;

// 自动把生成的 data URI 写回 style.css 中 .idle-tech-lines::before 的 background-image
const fs = require('fs');
const path = require('path');
const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'style.css');
let css = fs.readFileSync(cssPath, 'utf8');
const newCss = css.replace(
  /(\.idle-tech-lines::before\s*\{[^}]*background-image:\s*url\("data:image\/svg\+xml;base64,)[^"]+("\);)/s,
  `$1${base64}$2`
);
if (newCss === css) {
  console.error('未找到 .idle-tech-lines::before 的 background-image 占位，请检查 style.css');
  process.exit(1);
}
fs.writeFileSync(cssPath, newCss, 'utf8');
console.log(dataUri);
console.log(`已更新 ${cssPath}`);
