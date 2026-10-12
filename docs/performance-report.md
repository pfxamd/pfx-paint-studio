# PFx Paint Studio — measured long-session performance

Source: [successful browser run 38234812185](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38234812185) — 2026-10-12.

The benchmark runs the real self-hosted Hokusai WebAssembly engine in headless Chromium on an Ubuntu GitHub Actions runner. It is not a benchmark of the user's device or Firefox. Each test draws strokes across a 1200 × 800 pixel canvas, including five brush types in the full 300-stroke run, then measures undo, redo, snapshot creation, and complete replay from saved artwork.

| Metric | Normal CPU (300 strokes) | Emulated 3× CPU slowdown (180 strokes) |
|---|---:|---:|
| Actual samples retained | 6760 | 4057 |
| Stroke median (ms) | 0.3 | 0.9 |
| Stroke p95 (ms) | 1.2 | 3.6 |
| Stroke max (ms) | 5.8 | 7.6 |
| Undo median (ms, 8 operations) | 1.0 | 4.9 |
| Redo median (ms, 8 operations) | 0.9 | 4.3 |
| Snapshot creation (ms) | 8.6 | 12.3 |
| Rebuild from saved strokes (ms) | 163.2 | 189.1 |
| WASM memory buffer (MiB) | 63.7 | 45.3 |
| JS heap used (MiB, Chromium metric) | 3.5 | 2.8 |
| Saved image verified with full SHA-256 digest | yes | yes |

**Interpretation and limits:** the number of strokes and brush mixes differs across tests, so do not use the two columns as a device-to-device speed ratio. Throttling only simulates a slower CPU, not GPU or input-device performance. The stroke measurements time synchronous computation per entire stroke, not mouse-to-pixel latency or guaranteed 60 FPS. Chromium heap metrics exclude some native, GPU and browser process allocations; memory readings are not total RAM. One CI runner and one pass are insufficient to promise identical results on other hardware.

## How to rerun

Use the GitHub Actions workflow **Build and deploy PFx Paint Studio** → **Run workflow**. Manual dispatch includes both benchmarks; ordinary pushes retain the required painting, undo/redo, offline-resource, local-autosave, mobile and PNG regression checks but skip the heavier benchmarks.

The browser script is `tests/browser-performance.mjs` and produces two downloadable build artifacts: `performance.json` and `performance-cpu-3x.json`. It uses Node.js and Chromium's DevTools protocol; there is no runtime dependency in the paint app.

## Extended session: 1000 strokes

Source: [successful endurance run 38242759328](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38242759328) — 2026-10-12. This is one automated headless Chromium/Linux run at 1200 × 800 pixels. It executes 1000 genuine Hokusai strokes across five rotating brush presets and checks milestones in the same browser session. Exact canvas SHA-256 matches after eight undo operations, eight redo operations, and rebuilding from saved strokes at both 500 and 1000 strokes.

| Milestone | Points retained | Stroke median (ms) | Stroke p95 (ms) | WASM buffer (MiB) | JS heap after forced GC (MiB) | Cached checkpoints |
|---|---:|---:|---:|---:|---:|---:|
| 250 | 5632 | 0.4 | 1.5 | 37.4 | 1.6 | 3 |
| 500 | 11277 | 0.3 | 1.0 | 39.9 | 2.3 | 3 |
| 750 | 16897 | 0.2 | 0.9 | 69.1 | 3.0 | 3 |
| 1000 | 22534 | 0.3 | 0.9 | 69.1 | 3.7 | 3 |

At 500 strokes the restoration took **264 ms**, and IndexedDB autosave finished in approximately **200 ms**. At 1000 strokes restoration took **481 ms**, and autosave finished in approximately **218 ms**. Both completed with all saved stroke points intact and with **zero uncaught browser exceptions**.

**Interpretation:** no growth in the WASM buffer high-water mark or DOM node count (407 at every sample) was observed between strokes 750 and 1000. The JavaScript heap grew with the intentionally growing 1000-stroke history, which is expected. WASM buffer size is reserved memory, *not* live Rust allocation size. These observations do **not** establish that long-term memory leaks are absent, nor do they measure actual mouse-to-pixel latency or Firefox performance on the user's workstation.

The long-session test is kept in `tests/browser-endurance.mjs`, and emits `test-artifacts/endurance-report.json`. Run it explicitly using `workflow_dispatch` alongside the standard browser benchmark; normal pushes continue to run the shorter Chromium/Firefox functionality tests without delaying deployments.

## Interactive pointer-to-Canvas2D upload latency (2026-10-12)

The isolated regression `tests/browser-input-latency.mjs` sends actual Chromium
mouse events over a 1200 × 800 artwork and times input-event timestamps through
the return of `CanvasRenderingContext2D.putImageData`. It separately times
stroke processing, dirty-tile rasterization and the Canvas pixel upload.
The test uses headless Chromium/Linux with `--disable-gpu`, 65 paced mouse
moves per brush scenario and the real locally bundled WASM engine. It does
**not** measure display-compositor presentation, pen hardware or photon latency.

The baseline [run 38251818923](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38251818923)
used the original raster path with instrumentation only. The optimized
[run 38252698751](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38252698751)
uses an exact-bit-pattern cache for repeated floating-point sRGB channel
conversions, without changing the arithmetic for a cache miss.

| Scenario | Raster p95 before → after | Event-to-upload p95 before → after |
|---|---:|---:|
| Pencil, default size | 0.2 → 0.2 ms | 8.3 → 8.0 ms |
| Paint, default size | 1.3 → 0.4 ms | 9.4 → 8.4 ms |
| Paint, large size (+1 log-radius) | 5.2 → 1.0 ms | 13.3 → 8.9 ms |

The large Paint brush's raster median changed from **4.7 to 0.8 ms**. Pixel
upload itself remained at **0.1 ms p95 or less** for these scenarios. With
the test's 8 ms-paced input, frame upload gaps were generally around 16–17 ms
in both runs. Results are from **one CI sample per revision**, not matched
hardware sessions or statistical guarantees; variability and brush-specific
effects require more measurements. Existing browser tests still verify ink,
undo/redo, offline runtime, local autosave, and recovery. The sRGB cache
uses exact `f32` bit-pattern keys so repeated values produce the same 8-bit
channels as the original conversion, rather than approximating colors.
