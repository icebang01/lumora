# 扫描用户全部 LRC：找解析器不兼容/可疑格式
import os, re, glob
d = r"D:\Users\Administrator\Music\音乐"
files = glob.glob(os.path.join(d, "*.lrc")) + glob.glob(os.path.join(d, "*.LRC"))
ts_re = re.compile(r"\[(\d{1,2}:\d{1,2}(?:\.\d{1,3})?)\]")
print(f"LRC 文件数: {len(files)}")
issues = []
no_ts = []
multi_ts = 0
with_offset = 0
out_of_order = 0
for f in sorted(files):
    try:
        txt = open(f, encoding="utf-8", errors="replace").read()
    except Exception as e:
        issues.append((os.path.basename(f), "读取失败 " + str(e)))
        continue
    lines = txt.splitlines()
    timed = 0
    times = []
    has_offset = False
    for ln in lines:
        if re.search(r"\[offset:\s*[+-]?\d+\]", ln, re.I):
            has_offset = True
        ts = ts_re.findall(ln)
        if ts:
            timed += 1
            for t in ts:
                try:
                    mm, ss = t.split(":")
                    sec = int(mm) * 60 + float(ss)
                    times.append(sec)
                except Exception:
                    pass
    if has_offset: with_offset += 1
    if timed == 0:
        no_ts.append(os.path.basename(f))
    elif len(times) > 1 and times != sorted(times):
        out_of_order += 1
        issues.append((os.path.basename(f), f"时间戳乱序 {len(times)} 个, 首={times[0]:.2f} 次={times[1]:.2f}"))
# 时间戳跨度异常（首行 > 60s = 可能解析错误）
for f in sorted(files):
    try:
        txt = open(f, encoding="utf-8", errors="replace").read()
    except Exception:
        continue
    vals = []
    for ln in txt.splitlines():
        for x in ts_re.findall(ln):
            try:
                mm, ss = x.split(":")
                vals.append(int(mm) * 60 + float(ss))
            except Exception:
                pass
    if vals:
        first = min(vals)
        if first > 45:
            issues.append((os.path.basename(f), f"首时间戳 {first:.1f}s 偏晚"))
print(f"无时间戳(无法同步): {len(no_ts)}")
for n in no_ts[:10]: print("  -", n)
print(f"含 offset 标签: {with_offset}")
print(f"时间戳乱序: {out_of_order}")
print(f"可疑问题: {len(issues)}")
for name, why in issues[:12]:
    print(f"  - {name}: {why}")
