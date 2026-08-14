#!/usr/bin/env python3
"""Lumora 设计令牌 WCAG 对比度审计（只读诊断，不改任何文件）。
把 DESIGN.md / :root 的半透明令牌做 alpha 合成到各自基底背景，
计算前景/背景对比度（WCAG 2.1），对照 AA 标准标注达标情况。
"""
import re

def hex2rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def rgba_str(s):
    """解析 #rrggbb 或 rgba(r,g,b,a) → (r,g,b,a)"""
    s = s.strip()
    if s.startswith('#'):
        r, g, b = hex2rgb(s)
        return (r, g, b, 1.0)
    m = re.match(r'rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)', s)
    r, g, b = float(m.group(1)), float(m.group(2)), float(m.group(3))
    a = float(m.group(4)) if m.group(4) else 1.0
    return (r, g, b, a)

def composite(fg, bg):
    """把 fg (r,g,b,a) 合成到不透明 bg (r,g,b,1) 上，返回不透明 (r,g,b)"""
    fr, fg_, fb, fa = fg
    br, bg_, bb, _ = bg
    r = fr * fa + br * (1 - fa)
    g = fg_ * fa + bg_ * (1 - fa)
    b = fb * fa + bb * (1 - fa)
    return (r, g, b)

def rel_lum(rgb):
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def contrast(rgb1, rgb2):
    l1, l2 = rel_lum(rgb1), rel_lum(rgb2)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)

# ---- 基底背景（合成用的不透明底，模拟最暗情形）----
DARK_BG = rgba_str('#0b0c12')   # 暗色 Base BG（含视频/空闲）
LIGHT_BG = rgba_str('#f4f5f8')  # 亮色 Base BG

# ---- 令牌 ----
dark_surfaces = {
    'Surface-2 (32,35,46,.94)': 'rgba(32,35,46,0.94)',
    'Surface-1 (22,24,32,.86)': 'rgba(22,24,32,0.86)',
    'Surface-0 (14,15,20,.72)': 'rgba(14,15,20,0.72)',
}
light_surfaces = {
    'Surface-1 (255,255,255,.86)': 'rgba(255,255,255,0.86)',
    'Surface-2 (248,249,252,.96)': 'rgba(248,249,252,0.96)',
}
text_tokens = {
    'Text-1 (w,.96)': 'rgba(255,255,255,0.96)',
    'Text-2 (w,.68)': 'rgba(255,255,255,0.68)',
    'Text-3 (w,.42)': 'rgba(255,255,255,0.42)',
}
light_text = {
    'Text-1 (18,20,28,.95)': 'rgba(18,20,28,0.95)',
    'Text-2 (18,20,28,.64)': 'rgba(18,20,28,0.64)',
    'Text-3 (18,20,28,.50)': 'rgba(18,20,28,0.50)',
}
# 语义/品牌色（用作文字或强调标记时）
accent_colors = {
    'Accent #7c8cff': '#7c8cff',
    'Accent-Mid #8b7bff': '#8b7bff',
    'Like #ff5d8f': '#ff5d8f',
    'Warning #ffb454': '#ffb454',
    'Danger #e5484d': '#e5484d',
    'Success #5ee6a8': '#5ee6a8',
    'Sem-Info #6ee7ff': '#6ee7ff',
}

def rate(cr, large=False):
    AA = 3.0 if large else 4.5
    AAA = 4.5 if large else 7.0
    if cr >= AAA:  return 'AAA'
    if cr >= AA:   return 'AA '
    if cr >= 3.0:  return 'FAIL(<4.5 normal / 但≥3 UI)'
    return 'FAIL(<3)'

print('=' * 78)
print('DARK THEME — 文本令牌 vs 表面（合成到 Base BG #0b0c12）')
print('=' * 78)
print(f'{"文本":<22}{"表面":<26}{"对比度":>8}  评级(正常文字)')
for tname, t in text_tokens.items():
    trgb = rgba_str(t)
    for sname, s in dark_surfaces.items():
        srgb = rgba_str(s)
        # 表面合成到 base bg
        scomp = composite(srgb, DARK_BG)
        # 文本合成到（已合成的表面）
        fcomp = composite(trgb, (scomp[0], scomp[1], scomp[2], 1.0))
        cr = contrast(fcomp, scomp)
        print(f'{tname:<22}{sname:<26}{cr:>7.2f}  {rate(cr)}')

print()
print('=' * 78)
print('DARK THEME — 文本 vs 空闲 Base BG #0b0c12 (无表面)')
print('=' * 78)
for tname, t in text_tokens.items():
    trgb = rgba_str(t)
    fcomp = composite(trgb, DARK_BG)
    cr = contrast(fcomp, DARK_BG[:3])
    print(f'{tname:<22}{"Base BG":<26}{cr:>7.2f}  {rate(cr)}')

print()
print('=' * 78)
print('DARK THEME — 品牌/语义色 vs Surface-2（用作文字/强调标记时）')
print('=' * 78)
s2 = composite(rgba_str('rgba(32,35,46,0.94)'), DARK_BG)
for cname, c in accent_colors.items():
    crgb = rgba_str(c)[:3]
    cr = contrast(crgb, s2)
    print(f'{cname:<22}{"Surface-2":<26}{cr:>7.2f}  {rate(cr)} (large-text/UI ≥3)')

print()
print('=' * 78)
print('LIGHT THEME — 文本令牌 vs 表面（合成到 Base BG #f4f5f8）')
print('=' * 78)
print(f'{"文本":<26}{"表面":<26}{"对比度":>8}  评级')
for tname, t in light_text.items():
    trgb = rgba_str(t)
    for sname, s in light_surfaces.items():
        srgb = rgba_str(s)
        scomp = composite(srgb, LIGHT_BG)
        fcomp = composite(trgb, (scomp[0], scomp[1], scomp[2], 1.0))
        cr = contrast(fcomp, scomp)
        print(f'{tname:<26}{sname:<26}{cr:>7.2f}  {rate(cr)}')
