# Independent MyPaint visual reference — 2026-10-12

This comparison renders the **same inputs** independently with
the upstream **libmypaint 1.6.0-2build2** C library (Ubuntu Noble
`libmypaint-dev`) and the PFx Paint Studio Hokusai WebAssembly renderer.
The original imported `.myb` presets are unmodified.

## Reproducible setup

- Canvas: 320 × 180, transparent working tiles composited over white
- One stroke: 41 sampled positions, 8 trailing 16 ms idle samples
- Fixed HSV: (0.6, 0.7, 0.8); tilt 0; varying pressure
- Reference: system `libmypaint` **legacy** `mypaint_brush_stroke_to`,
  fixed tiled surface, premultiplied linear fix15 → white sRGB
- PFx: Hokusai WASM `strokeTo` / `finishStroke`, identical coordinates
- Three visual panels for each brush: upstream / Hokusai / ×4 amplified RGB difference
- Artifact: [successful comparison workflow run 38287760970](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38287760970)
- Scripts: `tests/upstream-reference-render.c`,
  `tests/browser-reference-render.mjs`, `tests/compare-reference-artwork.py`

## Measurements

Values are obtained from that **single** headless runner comparison.
The overlap metric is the intersection-over-union of pixels with any RGB
channel below 240, not a perceptual-quality score. RGB difference is
averaged across the entire artwork, including the white background.

| Imported preset | Ink coverage overlap | Average absolute RGB error (0–255) |
|---|---:|---:|
| Pastel | 99.966% | 0.002 |
| Watercolor glazing | 99.906% | 0.005 |
| Pencil | 72.350% | 0.026 |
| Dry brush | 66.559% | 0.726 |

**Interpretation:** Pastel and watercolor glazing agree extremely closely
on this gesture. Pencil and dry brush exhibit visible geometry/texture
differences against the native reference in the thresholded masks.
A low full-image RGB error can conceal shape differences because most
of the artboard is white. These differences are **not** grounds to
blindly rewrite brush physics without establishing the relevant upstream
reference semantics and the exact cause.

**Limitations:** The C reference uses the legacy stroke entry point, not
the modern `Surface2` spectral- and multi-smudge-aware variant. There
is only one short synthetic gesture at one colour and canvas size.
Different engine handling of per-brush RNG, dab spacing and final
lag catch-up can affect coverage. A real stylus and multiple stroke
directions/pressures are not covered, so no complete MyPaint parity
claim follows from the agreement above.

The comparison is manually repeatable in the repository's *Build and deploy*
workflow. The app continues to run fully locally and needs no upstream
C library at runtime. No visual changes were made to the live brush presets.
