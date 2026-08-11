'use strict';
/**
 * 生成测试素材。
 *
 * 联调播放器最麻烦的一点是"手边没有合适的片子"：要验证 HDR 得找
 * HDR 片源，要验证音画同步得找有明确对拍点的素材，要验证 10bit
 * 得找 10bit 编码。与其到处翻文件，不如让 ffmpeg 现造。
 *
 *   node tools/gen-testmedia.js [输出目录]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'testmedia'));

const CLIPS = [
  {
    file: 'sdr-1080p.mp4',
    desc: 'SDR 1080p30 · 基础回放与缩放算法对比',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=20',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ],
  },
  {
    file: 'sync-check.mp4',
    desc: '音画同步 · 每秒一次闪白配咔哒声，偏差肉眼可辨',
    args: [
      '-f', 'lavfi', '-i',
      "color=c=black:s=1280x720:r=60:d=20,geq=lum='if(lt(mod(T,1),0.06),235,16)':cb=128:cr=128",
      '-f', 'lavfi', '-i',
      "sine=frequency=1000:sample_rate=48000:duration=20,volume='if(lt(mod(t,1),0.06),1,0)':eval=frame",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
    ],
  },
  {
    file: 'hdr10-2160p.mp4',
    desc: 'HDR10 10bit BT.2020/PQ · 验证色调映射与高位深路径',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=24:duration=12',
      '-vf', 'format=yuv420p10le',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '24',
      '-pix_fmt', 'yuv420p10le',
      '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084',
      '-x265-params',
      'hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:' +
      'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
      '-tag:v', 'hvc1',
    ],
  },
  {
    file: 'banding.mp4',
    desc: '平滑渐变 · 验证去色带（deband）效果',
    args: [
      '-f', 'lavfi', '-i', 'gradients=size=1920x1080:rate=25:duration=12:nb_colors=2:speed=0.02',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    ],
  },
  {
    file: 'chapters.mkv',
    desc: '多章节 + 多音轨 · 验证章节跳转与轨道切换',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=30',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-metadata:s:a:0', 'title=低音测试轨', '-metadata:s:a:0', 'language=chi',
      '-metadata:s:a:1', 'title=高音测试轨', '-metadata:s:a:1', 'language=eng',
    ],
    chapters: [0, 10, 20],
  },
  {
    file: 'audio-only.mp3',
    desc: '纯音频 · 验证无视频轨时的降级路径',
    args: [
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=15',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      '-metadata', 'title=Lumen 测试音频',
    ],
  },
];

function ffmpeg() {
  const dir = process.env.FFMPEG_DIR;
  return dir ? path.join(dir, 'ffmpeg') : 'ffmpeg';
}

function writeChapterFile(marks, duration) {
  let text = ';FFMETADATA1\n';
  marks.forEach((start, i) => {
    const end = i + 1 < marks.length ? marks[i + 1] : duration;
    text += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${start * 1000}\nEND=${end * 1000}\n` +
            `title=第 ${i + 1} 章\n`;
  });
  const f = path.join(OUT, '.chapters.txt');
  fs.writeFileSync(f, text, 'utf8');
  return f;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`输出目录: ${OUT}\n`);

  let ok = 0;
  for (const clip of CLIPS) {
    const target = path.join(OUT, clip.file);
    process.stdout.write(`→ ${clip.file}  ${clip.desc}\n`);

    if (fs.existsSync(target)) {
      console.log('   已存在，跳过\n');
      ok++;
      continue;
    }

    let args = ['-hide_banner', '-loglevel', 'error', '-y', ...clip.args];
    if (clip.chapters) {
      const meta = writeChapterFile(clip.chapters, 30);
      // 章节元数据作为额外输入接进来。必须插在所有 -i 之后、
      // 第一个输出选项(-map)之前 —— ffmpeg 不接受输出选项后面再出现 -i
      const cut = args.indexOf('-map');
      const at = cut === -1 ? args.length : cut;
      args = [
        ...args.slice(0, at),
        '-i', meta, '-map_metadata', String(countInputs(clip.args)),
        ...args.slice(at),
      ];
    }
    args.push(target);

    try {
      execFileSync(ffmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const size = (fs.statSync(target).size / 1048576).toFixed(1);
      console.log(`   完成 (${size} MB)\n`);
      ok++;
    } catch (err) {
      const msg = (err.stderr && err.stderr.toString().trim().split('\n').pop()) || err.message;
      console.log(`   跳过：${msg}\n`);
    }
  }

  try { fs.unlinkSync(path.join(OUT, '.chapters.txt')); } catch { /* 没生成过 */ }
  console.log(`完成 ${ok}/${CLIPS.length} 个测试文件。`);
  console.log(`用 npm start -- "${path.join(OUT, 'sdr-1080p.mp4')}" 直接开播。`);
}

function countInputs(args) {
  let n = 0;
  for (const a of args) if (a === '-i') n++;
  return n;
}

main();
