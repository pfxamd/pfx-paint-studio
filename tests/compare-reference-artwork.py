#!/usr/bin/env python3
"""Independent MyPaint/Hokusai artwork comparison, with foreground metrics."""
import json
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path("test-artifacts")
PRESETS = ("pencil", "dry_brush", "pastel", "watercolor_glazing")
SCENARIOS = ("baseline", "reverse", "zigzag", "primed")
W, H = 320, 180
THRESHOLDS = (200, 230, 240, 250)


def ppm(path):
    raw = path.read_bytes()
    header = f"P6\n{W} {H}\n255\n".encode()
    if not raw.startswith(header) or len(raw) != len(header) + W * H * 3:
        raise ValueError(f"Invalid PPM: {path}")
    return raw[len(header):]


def write_png(path, width, height, data):
    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload +
                struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff))
    scanlines = b"".join(b"\0" + data[y*width*3:(y+1)*width*3]
                         for y in range(height))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" +
        chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
        chunk(b"IDAT", zlib.compress(scanlines, 6)) +
        chunk(b"IEND", b""))


def ink_mask(rgb, threshold):
    return {i for i in range(len(rgb) // 3)
            if min(rgb[i*3:i*3+3]) < threshold}


def bounds_and_center(mask, width):
    if not mask:
        return None, None
    xs = [i % width for i in mask]
    ys = [i // width for i in mask]
    return [min(xs), min(ys), max(xs), max(ys)], [
        round(sum(xs)/len(xs), 2), round(sum(ys)/len(ys), 2)]


def compare(a, b, width=W):
    if len(a) != len(b) or not a or len(a) % 3:
        raise ValueError("Invalid or differently sized RGB buffers")
    full_mae = sum(abs(x-y) for x, y in zip(a,b))/len(a)
    thresholds = {}
    for threshold in THRESHOLDS:
        reference = ink_mask(a, threshold)
        rendered = ink_mask(b, threshold)
        union = reference | rendered
        intersection = reference & rendered
        thresholds[str(threshold)] = {
            "coverage_iou": round(len(intersection)/len(union) if union else 1, 5),
            "reference_ink_pixels": len(reference),
            "hokusai_ink_pixels": len(rendered),
            "reference_only_pixels": len(reference - rendered),
            "hokusai_only_pixels": len(rendered - reference),
        }
    reference = ink_mask(a, 240)
    rendered = ink_mask(b, 240)
    union = reference | rendered
    foreground_delta = sum(
        abs(a[3*i+k]-b[3*i+k]) for i in union for k in range(3))
    ref_bbox, ref_center = bounds_and_center(reference, width)
    pfx_bbox, pfx_center = bounds_and_center(rendered, width)
    return {
        "mean_absolute_rgb_difference": round(full_mae, 4),
        "foreground_rgb_difference": round(
            foreground_delta/(3*len(union)) if union else 0, 4),
        "coverage_iou_under_240": thresholds["240"]["coverage_iou"],
        "reference_marked_pixels": len(reference),
        "hokusai_marked_pixels": len(rendered),
        "threshold_sweep": thresholds,
        "reference_bbox": ref_bbox,
        "hokusai_bbox": pfx_bbox,
        "reference_center": ref_center,
        "hokusai_center": pfx_center,
    }


def self_test():
    white = bytes([255,255,255] * 6)
    assert compare(white, white, 3)["coverage_iou_under_240"] == 1
    assert compare(white, white, 3)["reference_marked_pixels"] == 0
    a = bytearray(white)
    a[0:3] = bytes((30,30,30))
    assert compare(a,a,3)["foreground_rgb_difference"] == 0
    b = bytearray(white)
    b[3:6] = bytes((30,30,30))
    different = compare(a,b,3)
    assert different["coverage_iou_under_240"] == 0
    assert different["threshold_sweep"]["240"]["reference_only_pixels"] == 1
    assert different["threshold_sweep"]["240"]["hokusai_only_pixels"] == 1
    assert different["reference_bbox"] == [0,0,0,0]
    assert different["hokusai_bbox"] == [1,0,1,0]
    assert different["foreground_rgb_difference"] > 0
    print("REFERENCE_METRICS_SELF_TEST_OK")


def row(rgb, line):
    return rgb[line*W*3:(line+1)*W*3]


def main(check):
    report = {
        "upstream": "system libmypaint, legacy stroke API",
        "method": "same MYB, HSV, 41 sampled positions and exactly 8 trailing samples",
        "limitations": "RGB over white; synthetic stylus, no Surface2, no spectral mode",
        "cases": {}, "regressions": [],
    }
    panels = []
    for preset in PRESETS:
        for scenario in SCENARIOS:
            suffix = "" if scenario == "baseline" else "_" + scenario
            a = ppm(ROOT / f"upstream_{preset}{suffix}.ppm")
            b = ppm(ROOT / f"hokusai_{preset}{suffix}.ppm")
            stats = compare(a,b)
            report["cases"][f"{preset}/{scenario}"] = stats
            diff = bytes(min(255, abs(x-y)*4) for x,y in zip(a,b))
            panels.append((a,b,diff))
            if min(stats["reference_marked_pixels"],
                   stats["hokusai_marked_pixels"]) < 3:
                report["regressions"].append(f"{preset}/{scenario}: blank or nearly blank")
            # Conservative baseline guard; no claim of artistic parity.
            floors = {"pencil": 0.40, "dry_brush": 0.40,
                      "pastel": 0.85, "watercolor_glazing": 0.85}
            if scenario == "baseline" and stats["coverage_iou_under_240"] < floors[preset]:
                report["regressions"].append(
                    f"{preset}: coverage IoU {stats['coverage_iou_under_240']}"
                    f" below regression floor {floors[preset]}")
    sheet = bytearray()
    for a,b,diff in panels:
        for y in range(H):
            sheet.extend(row(a,y))
            sheet.extend(row(b,y))
            sheet.extend(row(diff,y))
    write_png(ROOT/"reference-visual-comparison.png", W*3, H*len(panels), bytes(sheet))
    (ROOT/"reference-visual-comparison.json").write_text(
        json.dumps(report, indent=2) + "\n")
    print("REFERENCE_VISUAL_COMPARISON", json.dumps(report, sort_keys=True))
    if check and report["regressions"]:
        raise SystemExit("Comparison regression(s): " + "; ".join(report["regressions"]))


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        main("--check" in sys.argv)
