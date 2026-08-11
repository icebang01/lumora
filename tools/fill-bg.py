#!/usr/bin/env python3
"""Fill transparent/checkered background of PNG assets with the app background color."""
import sys
from pathlib import Path
from PIL import Image

BG = (240, 244, 248)  # #f0f4f8, matches #music-stage.style-vinyl gradient start

def fill_bg(src: Path, dst: Path):
    img = Image.open(src).convert('RGBA')
    bg = Image.new('RGBA', img.size, BG + (255,))
    out = Image.alpha_composite(bg, img)
    out.convert('RGB').save(dst, 'PNG', optimize=True)
    print(f"wrote {dst}")

if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    fill_bg(root / 'src/renderer/assets/turntable/base.png', root / 'src/renderer/assets/turntable/base.png')
    fill_bg(root / 'src/renderer/assets/turntable/tonearm.png', root / 'src/renderer/assets/turntable/tonearm.png')
