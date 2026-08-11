# 解码 wav 前 5 秒 → FFT 频谱，判断内容是真实音乐还是纯音
import subprocess, numpy as np, sys

wav = r"D:\IDEA\videos\testmedia-real\音乐测试\区瑞强-月亮代表我的心24bit96khz.wav"
out = r"D:\IDEA\videos\_design_archive\decoded-pcm.f32"
# 取前 5 秒，重采样 48k 双声道（与播放器 decoder 相同参数）
subprocess.run([
    r"D:\IDEA\videos\bin\ffmpeg.exe", "-y", "-v", "error",
    "-i", wav, "-t", "5", "-ar", "48000", "-ac", "2",
    "-f", "f32le", out,
], check=True)

data = np.fromfile(out, dtype=np.float32)
print("样本数:", len(data), "时长:", len(data)/48000/2, "s")
print("峰值:", np.abs(data).max(), "RMS:", np.sqrt((data**2).mean()))
if len(data) == 0:
    sys.exit(1)

# 取左声道做 FFT
mono = data[::2]
seg = mono[: 48000 * 2]  # 前 2 秒
win = np.hanning(len(seg))
spec = np.abs(np.fft.rfft(seg * win))
freqs = np.fft.rfftfreq(len(seg), 1/48000)
# 前 20 个最强频率
idx = np.argsort(spec)[::-1][:20]
print("\n最强频率成分:")
for i in idx:
    if spec[i] > 0:
        print(f"  {freqs[i]:8.1f} Hz  幅度 {spec[i]:.1f}")
# 能量分布：0-500, 500-2k, 2k-5k, 5k-10k, 10k-20k
bands = [(0,500),(500,2000),(2000,5000),(5000,10000),(10000,24000)]
total = spec.sum()
print("\n频段能量占比:")
for lo, hi in bands:
    m = (freqs >= lo) & (freqs < hi)
    print(f"  {lo:>5}-{hi:<6} Hz: {spec[m].sum()/total*100:5.1f}%")
