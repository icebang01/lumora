# 扫描用户 LRC：word-LRC（行内 <mm:ss.xx> 逐字标签）分布
import os, re, glob
d = r"D:\Users\Administrator\Music\音乐"
files = glob.glob(os.path.join(d, "*.lrc")) + glob.glob(os.path.join(d, "*.LRC"))
word_re = re.compile(r"<\d{1,2}:\d{1,2}(?:\.\d{1,3})?>")
print(f"LRC 总数: {len(files)}")
with_word = []
for f in sorted(files):
    try:
        txt = open(f, encoding="utf-8", errors="replace").read()
    except Exception:
        continue
    n = 0
    for ln in txt.splitlines():
        n += len(word_re.findall(ln))
    if n > 0:
        with_word.append((os.path.basename(f), n))
print(f"含逐字时间戳(word-LRC): {len(with_word)}")
for name, n in with_word[:15]:
    print(f"  - {name}: {n} 个标签")
if not with_word:
    print("  （无——全部是普通 LRC，逐字只能均匀估算）")
# 抽查 G.E.M. 歌的每行字数分布（估算效果参考）
g = os.path.join(d, "G.E.M.邓紫棋-多远都要在一起.lrc")
if os.path.exists(g):
    txt = open(g, encoding="utf-8", errors="replace").read()
    print("\nG.E.M. 歌前 5 行（时间戳+文本长度）:")
    for ln in txt.splitlines()[:5]:
        m = re.match(r"\[([\d:.]+)\]\s*(.*)", ln)
        if m:
            print(f"  [{m.group(1)}] {m.group(2)[:24]} ({len(m.group(2))}字)")
