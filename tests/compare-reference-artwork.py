#!/usr/bin/env python3
"""Three-panel native MyPaint vs Hokusai visual comparison, without Pillow."""
import json, struct, zlib
from pathlib import Path

ROOT = Path("test-artifacts")
PRESETS = ["pencil", "dry_brush", "pastel", "watercolor_glazing"]
W, H = 320, 180

def ppm(path):
    raw = path.read_bytes()
    header = b"P6\n320 180\n255\n"
    if not raw.startswith(header) or len(raw) != len(header) + W*H*3:
        raise ValueError(f"Invalid PPM: {path}")
    return raw[len(header):]

def png(path, w, h, data):
    scanlines = b"".join(b"\0" + data[y*w*3:(y+1)*w*3] for y in range(h))
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(
            ">I", zlib.crc32(kind + payload))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" +
        chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) +
        chunk(b"IDAT", zlib.compress(scanlines, 6)) +
        chunk(b"IEND", b"")
    )

def row(rgb, line):
    return rgb[line*W*3:(line+1)*W*3]

report = {"upstream": "libmypaint from the Ubuntu distribution",
          "samples": "same brush JSON, HSV, pointer locations, pressure and timing",
          "caveat": "Reference uses the legacy libmypaint stroke API; color/rasterization differences are measured, not asserted as parity",
          "presets": {}}
panels = []
for preset in PRESETS:
    a = ppm(ROOT / f"upstream_{preset}.ppm")
    b = ppm(ROOT / f"hokusai_{preset}.ppm")
    dif = bytes(min(255, abs(v-u)*4) for u,v in zip(a,b))
    delta = sum(abs(u-v) for u,v in zip(a,b))
    changed = sum(u != v for u,v in zip(a,b))
    mask1 = {i for i in range(W*H) if min(a[i*3:i*3+3]) < 240}
    mask2 = {i for i in range(W*H) if min(b[i*3:i*3+3]) < 240}
    intersection = len(mask1 & mask2)
    union = len(mask1 | mask2)
    report["presets"][preset] = {
        "mean_absolute_rgb_difference": round(delta/len(a),3),
        "fraction_channels_changed": round(changed/len(a),5),
        "coverage_iou_under_240": round(intersection/union if union else 1,5),
        "reference_marked_pixels":len(mask1),
        "hokusai_marked_pixels":len(mask2)}
    panels.append((a,b,dif))
sheet = bytearray()
for a,b,dif in panels:
    for y in range(H):
        sheet.extend(row(a,y))
        sheet.extend(row(b,y))
        sheet.extend(row(dif,y))
png(ROOT/"reference-visual-comparison.png",W*3,H*len(panels),bytes(sheet))
(ROOT/"reference-visual-comparison.json").write_text(json.dumps(report,indent=2)+"\n")
print("REFERENCE_VISUAL_COMPARISON",json.dumps(report,sort_keys=True))
