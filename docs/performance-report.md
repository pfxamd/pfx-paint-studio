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

## Heavy-brush latency regression and exact-output transfer optimization (2026-10-12)

The extended, opt-in test `PFX_LATENCY_STRESS=1 node tests/browser-input-latency.mjs`
exercises seven additional large/textured brush scenarios with real browser-dispatched
mouse events, measuring both brush processing and dirty-pixel rasterization.
It runs headless Chromium/Linux on the GitHub Actions CI runner with
software rendering. The tested output endpoint is the completion of the
Canvas 2D pixel upload, **not physical screen presentation**.

One [unoptimized baseline run (38255148561)](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38255148561)
was compared to one [experimental optimized run (38255677118)](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38255677118).
Both used 65 paced moves per scenario on a 1200 × 800 canvas:

| Brush / size offset | Dirty raster p95, before → after | Event-to-upload p95, before → after | Frame gaps over 25 ms, before → after |
|---|---:|---:|---:|
| Pencil / 0 | 0.2 → 0.2 ms | 8.1 → 8.8 ms | 0 → 0 |
| Paint / 0 | 0.5 → 0.2 ms | 8.6 → 8.3 ms | 0 → 0 |
| Paint / +1 | 0.9 → 0.5 ms | 9.1 → 8.8 ms | 0 → 0 |
| Paint / +2 | 3.4 → 1.8 ms | 12.2 → 11.0 ms | 0 → 0 |
| Expressive watercolor / +1 | **21.5 → 7.5 ms** | **39.1 → 18.3 ms** | **16 → 0** |
| Oil / +1 | 2.4 → 1.0 ms | 10.7 → 9.3 ms | 0 → 0 |
| Pastel / +1 | 3.7 → 1.4 ms | 12.4 → 10.6 ms | 0 → 0 |
| Marker / +1 | 1.4 → 0.5 ms | 9.4 → 8.6 ms | 0 → 0 |
| Dry Brush / +1 | 1.5 → 0.6 ms | 9.7 → 8.7 ms | 0 → 0 |
| Texture Ink / +1 | 1.9 → 0.7 ms | 10.0 → 8.7 ms | 1 → 0 |

The additional optimization keeps the existing bit-exact sRGB cache and uses
a shared 4096-bin table for the 8-bit conversion. When *both ends of a bin*
round to the same 8-bit channel value, monotonicity guarantees that all
intermediate inputs yield that byte. Boundary-crossing bins still run the
original `linear_to_srgb` computation, without approximating the output.
A Rust regression checks 1,000,000 evenly spaced values and neighbors around
every 8-bit output transition, plus the existing randomized channel tests.
All existing browser interaction tests continued to pass.

The larger watercolor scenario showed a roughly **65% reduction in raster p95**
and **53% reduction in event-to-upload p95**. This is one pair of CI runs:
variability, hardware stylus latency, long-session behavior, and other
operating systems were **not** established by these measurements. The stress
run is optional to keep routine CI and deployments short.


## 2000 heavy-brush strokes in Chromium and Firefox (2026-10-12)

**Verified CI:** [GitHub Actions run 38264932324](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38264932324), using `tests/heavy-endurance.mjs`.
The test runs the *actual locally bundled Hokusai WASM engine* in two genuine headless
browsers, drawing 2000 strokes with 8 rotating heavy presets: expressive/glazing
watercolor, oil, acrylic, pastel, dry brush, textured ink and paint. Each 1200 × 800
canvas retained **44,093 sample points**. Some strokes use simulated pen pressure
and tilt; no physical stylus was used.

The script sampled milestones at 500 / 1000 / 1500 / 2000 strokes, checked the
checkpoint bound, and measured engine work + the WASM memory buffer. It also
tested at 1000 and 2000 strokes: eight undo and redo actions, byte-identical
SHA-256 digests after undo/redo and full reconstruction, complete IndexedDB
autosave, and at 2000 strokes a *full page reload*, independent artwork load and
pixel-identical restore. **Both browsers passed with zero uncaught exceptions.**

| 2000-stroke metric | Chromium | Firefox |
|---|---:|---:|
| Retained stroke points | 44,093 | 44,093 |
| Stroke median / p95 | 1.2 / 10.4 ms | 9 / 123 ms |
| Full reconstruct from 2000 strokes | 5,149 ms | 53,717 ms |
| Restore after page reload | 5,173 ms | 53,923 ms |
| Autosave completion | 300 ms | 389 ms |
| WASM buffer high-water size | 103.9 MiB | 103.8 MiB |
| JS heap reported by the browser | 7.6 MiB | Unavailable |
| Replay, undo/redo, reload pixels | Exact | Exact |

At 1000 heavy strokes, undo/redo operations were slow in both browsers because
the nearest snapshot can be up to 23 strokes behind the current history
length: Chromium median undo/redo **113.5 / 122 ms**; Firefox **1304 / 1430 ms**.
At 2000 strokes the snapshot alignment differed, so undo/redo medians were
much lower; do not interpret this as proof of improving long-session speed.

At the 2000-stroke milestone, the WASM buffer had stopped growing after
1500 strokes in both runs (reserved linear memory, **not** live Rust allocation
or total browser RAM). Chromium reported a 7.6 MiB JS heap; the test cannot
measure Firefox JS heap, so no Firefox heap/total-memory claim is made.

**Measured bottleneck:** Firefox full replay on this heavy workload takes about
54 seconds. This is functionally correct but **not** acceptably responsive;
future optimization should target heavy-stroke replay/restore and the
snapshot-alignment-dependent undo cost, with exact-pixel regression tests.
No performance fix is claimed from this stress-test-only change.

**Limitations:** the workloads are generated programmatically using the real
brush engine, not 2000 real hand movements. A requestAnimationFrame checkpoint
after each 8 strokes estimates frame gaps *under deliberate main-thread overload*;
it is **not** a measurement of continuous on-screen drawing latency. CI runner
hardware, headless renderers and JIT conditions differ; comparisons are not
a guarantee of performance on user devices. This is one CI run per browser.

**Repeat:** manually launch the repository's *Build and deploy PFx Paint Studio*
workflow using `workflow_dispatch`, then inspect the
`test-artifacts/heavy-endurance.json` report. The 2000-stroke suite is
manual-only after this initial verified run, so it does not delay every PR.

## Verified fast local restore for heavy artwork (2026-10-12)

An optional lossless local cache now persists recent internal **fix15 tile
checkpoints**, compressed with the browser's built-in deflate stream, in the
same IndexedDB artwork record as the original stroke history. The existing
stroke schema remains intact (schema version 1). On reload the implementation
SHA-256 checks the stroke prefix and uncompressed tile payload for every
candidate, validates tile dimensions/coordinates/channel bounds, restores
recent checkpoints and replays only the remaining strokes. Corrupted,
unsupported, missing or obsolete caches fall back to full original-stroke
replay. Previously saved artwork is still readable; after its first successful
legacy load the app schedules a new optional cache for later reloads. The
same compressed payload is reused between autosaves while its checkpoint
identity is unchanged, avoiding repeated compression on every save.

**Cross-browser verification:** [successful PR run 38271488932](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38271488932).
The benchmark executes 2,000 heavy strokes and retains 44,093 original
points per browser. Stored artwork, undo/redo, and both full and cached
reconstruction have the same exact pixel digest. Corruption and legacy
fallback are also exercised by the ordinary Chromium browser regression.

| 2000-stroke reload benchmark | Earlier full replay | Cached reload (verified PR) |
|---|---:|---:|
| Chromium / headless Linux | 5,173 ms | 330 ms |
| Firefox / headless Linux | 53,923 ms | 793 ms |

The separate [earlier successful cache-validation run 38269627967](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38269627967)
measured cached reconstruction at **304 ms Chromium / 544 ms Firefox**.
The variation across CI runs is why these values are observations, not
service-level latency promises. Firefox's former ~54-second reload is now
under 1 second in both measured optimized runs, an improvement of over 98%.

**Trade-offs:** the three compressed checkpoints in the 2,000-stroke test
occupied ~12.2 MB in the Chromium IndexedDB record and ~12.2 MB in the Firefox
record (decimal MB). The first cached autosave at that milestone took about
1.2 s in Chromium and 1.8 s in Firefox in this workload, versus ~0.3 and
~0.4 s for the previous no-cache save. Subsequent unchanged checkpoints
reuse their compressed representation, but IndexedDB still has to write it.
The cache is optional and bounded by a 12 MiB payload budget; the newest
checkpoint is preferred when the whole recent set would exceed the budget.
Loading a legacy 2,000-stroke painting **for the first time** still requires
a full replay before a cache can be created.

Full reconstruction *without* a cache and checkpoint-boundary undo spikes
remain slower in Firefox; this improvement addresses **cached reloads**, not
the underlying heavy-brush computation. The benchmark uses synthetic
pressured pen and mouse samples in genuine headless browsers; it does not
measure physical stylus hardware, screen presentation or total process RAM.

## In-session undo/redo: four-stroke checkpoints (2026-10-12)

Earlier dense watercolor and textured-brush drawings showed **undo/redo spikes**
when the previous in-memory checkpoint was up to 23 strokes behind the
history position. This change takes a tiled checkpoint every **4 completed
strokes** instead of 24, still retaining **at most 3 in-memory checkpoints**.
It changes neither source stroke data nor saved schema. Cached tile
checkpoints saved at the old 24-stroke intervals remain restorable.

Results from three successful, separate 2000-heavy-stroke Chromium/Firefox CI
runs on 1200 × 800 artwork with **44,093 points** and 8 rotating heavy brush
presets, including pressure and tilt simulations:

- Baseline 24-stroke checkpoints: [run 38271488932](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38271488932).
- Experimental 8-stroke checkpoints: [run 38276326902](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38276326902).
- Selected 4-stroke checkpoints: [run 38277203221](https://github.com/pfxamd/pfx-paint-studio/actions/runs/38277203221).

| 1000-stroke metric (median of 8 actions) | Every 24 | Every 8 | Every 4 |
|---|---:|---:|---:|
| Firefox undo | 1,278 ms | 357 ms | **116 ms** |
| Firefox redo | 1,396 ms | 475 ms | **202 ms** |
| Chromium undo | 108.8 ms | 31.1 ms | **10.5 ms** |
| Chromium redo | 118.9 ms | 40.9 ms | **17.4 ms** |

At 2000 strokes the workload aligned with the 4- and 8-stroke
checkpoints, while the original 24-stroke snapshots still had a comparatively
cheap remaining replay tail. Undo/redo were fast in all three runs: the selected
four-stroke version measured **3/6 ms median in Firefox** and **1.1/1.3 ms in
Chromium**. Testing misaligned and heavy tails at 1000 strokes is therefore
essential to reveal the worst responsiveness spikes.

| 2000-stroke drawing metric | Every 24 | Every 4 |
|---|---:|---:|
| Firefox stroke p95 | 120 ms | 96 ms |
| Chromium stroke p95 | 10.1 ms | 8.3 ms |
| Firefox WASM buffer | 103.9 MiB | 103.8 MiB |
| Chromium WASM buffer | 103.8 MiB | 103.7 MiB |
| Chromium JS heap reported | 7.7 MiB | 7.8 MiB |
| Firefox cached full-page reload | 793 ms | 595 ms |
| Chromium cached full-page reload | 330 ms | 289 ms |

All three stress runs completed their checks for byte-identical SHA-256
pixels after undo, redo, historical reconstruction, local autosave and a full
page reload. Normal drawing, erasing and other browser interactions also
passed. The cached checkpoint format is unchanged. A separate browser
regression verifies both damaged-cache fallback and compatibility with
previously saved checkpoints on 24-stroke boundaries.

These are **three individual CI runs**, not repeated statistical samples on
controlled hardware; the unexpected gains in drawing p95 may partly reflect
runner variance. Frame gaps within the stress suite include deliberate
main-thread overload. Firefox live JS heap and total resident memory were not
measured. No physical tablet stylus or display-to-photon latency was tested.

The remaining worst-case after four-stroke checkpointing is replay of up
to three heavy brush strokes when the history is between checkpoints. The
in-memory three-checkpoint limit controls memory usage and makes the change
compatible with existing local documents.
