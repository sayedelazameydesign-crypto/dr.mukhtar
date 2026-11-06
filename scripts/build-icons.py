#!/usr/bin/env python3
"""Render the install icons from the same shapes as brand.svg.

Why this script exists: the shared runners (and this sandbox) have ImageMagick without an
SVG renderer, so `convert brand.svg` fails and the icons would otherwise be hand-made
binaries nobody can reproduce. Everything here is stdlib: a small rasteriser plus a PNG
writer, so `python3 scripts/build-icons.py` regenerates byte-identical icons anywhere.

Shapes are copied from brand.svg (64x64 viewBox): the rounded tile, the monitor outline,
the two antenna strokes and the pulse line.
"""

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "icons"

VIEW = 64.0
BG = (0x0E, 0x6F, 0x61)       # --ink / brand green
INK = (0xEA, 0xF5, 0xF0)      # brand paper
SAMPLES = 4                    # supersampling per axis: 16 samples per pixel

MONITOR = (14.0, 20.0, 36.0, 30.0, 8.0, 3.2)   # x, y, w, h, radius, stroke
ANTENNAE = [((23.0, 15.0), (23.0, 24.0), 3.4), ((41.0, 15.0), (41.0, 24.0), 3.4)]
PULSE = [((21.0, 35.0), (27.5, 35.0)), ((27.5, 35.0), (30.7, 28.0)),
         ((30.7, 28.0), (35.3, 41.0)), ((35.3, 41.0), (38.5, 35.0)),
         ((38.5, 35.0), (45.0, 35.0))]
PULSE_WIDTH = 3.0


def in_rounded_rect(px, py, x, y, w, h, r):
    if px < x or px > x + w or py < y or py > y + h:
        return False
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def in_stroke_rounded_rect(px, py, x, y, w, h, r, stroke):
    if not in_rounded_rect(px, py, x, y, w, h, r):
        return False
    inner_ok = in_rounded_rect(px, py, x + stroke, y + stroke, w - 2 * stroke, h - 2 * stroke,
                               max(r - stroke, 0.1))
    return not inner_ok


def in_segment(px, py, a, b, width):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
    nearest_x, nearest_y = ax + t * dx, ay + t * dy
    return (px - nearest_x) ** 2 + (py - nearest_y) ** 2 <= (width / 2.0) ** 2


def ink_at(px, py):
    """Is the brand ink at this point? Everything is expressed in the 64-unit viewbox."""
    x, y, w, h, r, stroke = MONITOR
    if in_stroke_rounded_rect(px, py, x, y, w, h, r, stroke):
        return True
    for start, end, width in ANTENNAE:
        if in_segment(px, py, start, end, width):
            return True
    for start, end in PULSE:
        if in_segment(px, py, start, end, PULSE_WIDTH):
            return True
    return False


def render(size, maskable):
    """Return RGBA rows.

    `maskable` fills the whole square and shrinks the artwork into the 80% safe zone, so
    Android's own mask never clips the monitor. The plain icons keep a transparent ring
    outside a rounded tile, which is what iOS and desktop expect.
    """
    scale = size / VIEW
    inset = 0.0
    if maskable:
        # 80% safe zone: the artwork is drawn at 80% and centred.
        scale *= 0.8
        inset = (size - VIEW * scale) / 2.0
    radius = 14.0
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            bg_hits = 0
            ink_hits = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    fx = px + (sx + 0.5) / SAMPLES
                    fy = py + (sy + 0.5) / SAMPLES
                    vx = (fx - inset) / scale
                    vy = (fy - inset) / scale
                    if maskable:
                        bg_hits += 1
                    elif in_rounded_rect(vx, vy, 0.0, 0.0, VIEW, VIEW, radius):
                        bg_hits += 1
                    if ink_at(vx, vy):
                        ink_hits += 1
            total = SAMPLES * SAMPLES
            bg_alpha = bg_hits / total
            ink_alpha = ink_hits / total
            # Ink is composited over the tile; outside the tile everything stays transparent.
            base = BG
            alpha = bg_alpha
            colour = [base[0] * (1 - ink_alpha) + INK[0] * ink_alpha,
                      base[1] * (1 - ink_alpha) + INK[1] * ink_alpha,
                      base[2] * (1 - ink_alpha) + INK[2] * ink_alpha]
            row.extend((int(round(colour[0])), int(round(colour[1])), int(round(colour[2])),
                        int(round(alpha * 255))))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in (("icon-192.png", 192, False),
                                 ("icon-512.png", 512, False),
                                 ("icon-maskable-512.png", 512, True)):
        target = OUT / name
        write_png(target, size, render(size, maskable))
        print(f"wrote {target.relative_to(ROOT)} ({size}x{size}, {target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
