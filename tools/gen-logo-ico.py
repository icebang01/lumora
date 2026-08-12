#!/usr/bin/env python3
"""Generate a multi-size Lumora app icon (ICO) with PNG-compressed frames."""
from PIL import Image, ImageDraw
import io
import math
import os
import struct

SIZES = [16, 24, 32, 48, 64, 128, 256]
OUT = os.path.join(os.path.dirname(__file__), '..', 'build', 'icons', 'icon.ico')

# Brand gradient sampled from idle-mark SVG
C1 = (0x6e, 0xe7, 0xff)  # cyan
C2 = (0x8b, 0x7b, 0xff)  # purple
C3 = (0xff, 0x7a, 0xc6)  # pink
WHITE = (255, 255, 255, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_color(x, y, size):
    # diagonal from top-left (C1) via center (C2) to bottom-right (C3)
    t = (x + y) / (2 * max(size - 1, 1))
    if t < 0.5:
        return lerp(C1, C2, t / 0.5)
    return lerp(C2, C3, (t - 0.5) / 0.5)


def make_logo(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = cy = size / 2
    r = size * 0.45

    # 1. gradient-filled circle with antialiased edge
    pixels = img.load()
    r2 = r * r
    for y in range(size):
        for x in range(size):
            dx = x - cx + 0.5
            dy = y - cy + 0.5
            d2 = dx * dx + dy * dy
            if d2 <= r2:
                col = gradient_color(x, y, size)
                alpha = 255
                if d2 > (r - 1) * (r - 1):
                    alpha = int(max(0, 255 * (r - math.sqrt(d2))))
                pixels[x, y] = (*col, alpha)

    # 2. white play triangle, same proportions as idle-mark SVG
    # idle-mark: viewBox 64x64, circle r=32, triangle (26,23.5)-(43,32)-(26,40.5)
    scale = size / 64.0
    tri = [
        (26 * scale, 23.5 * scale),
        (43 * scale, 32 * scale),
        (26 * scale, 40.5 * scale),
    ]
    draw.polygon(tri, fill=WHITE)
    return img


def build_ico(png_frames):
    """Build a Windows ICO with PNG-compressed frames (Vista+)."""
    out = io.BytesIO()
    count = len(png_frames)
    # ICONDIR: reserved(2), type(2), count(2)
    out.write(struct.pack('<HHH', 0, 1, count))

    # ICONDIRENTRY: 16 bytes each
    offset = 6 + 16 * count
    entries = []
    for size, data in png_frames:
        # width/height are bytes; 0 means 256
        w = size if size < 256 else 0
        h = size if size < 256 else 0
        entries.append(struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(data), offset))
        offset += len(data)

    for entry in entries:
        out.write(entry)
    for _, data in png_frames:
        out.write(data)

    return out.getvalue()


if __name__ == '__main__':
    png_frames = []
    for s in SIZES:
        img = make_logo(s)
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        png_frames.append((s, buf.getvalue()))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(build_ico(png_frames))
    print(f'Wrote {OUT} with sizes {SIZES}')
