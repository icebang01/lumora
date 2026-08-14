/**
 * 音频文件路径判定（共享单例）。
 * 原散落于 app-events / input / idle / playlist / app(_modeForPath) 多份完全相同实现，
 * 各自还声明一份 AUDIO_EXT 常量；现集中维护，扩展名列表只此一处，避免日后漂移。
 */
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|wma|ogg|opus|ac3|dts|eac3|mka|ape|tta|tak|alac|wv)$/i;

export function isAudioPath(p) {
  return AUDIO_EXT.test(String(p || ''));
}
