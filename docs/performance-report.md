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
