# PFx Paint Studio

Local-first digital painting workspace — **Alpha 0.1.0**.

Features: 12 bundled Hokusai-powered artist brushes with real rendered previews, smooth cursor-centered zoom (100%–800%), middle-mouse or Space+drag panning and one-click Fit, pen pressure and tilt, colours and palette, size, eraser, colour picker, undo/redo, clear, and PNG export. Designed for one screen without page scrolling.

## Runtime architecture

- Original UI, pointer input, stroke history and PNG export: `index.html`, `src/app.js`, `src/engine.js`, `src/style.css`.
- Desktop-only visual finish (graphite workbench, brush gallery, toolbar, typography and palette) is isolated in `src/studio-polish.css`; the existing mobile presentation and drawing algorithms remain independently editable.
- Hokusai core, `.myb` parser, in-memory tiled surface, and WASM bindings: source copied into `vendor/hokusai/`.
- Twelve `.myb` artist brush settings are stored in `public/brushes/` (4 from Hokusai examples and 8 CC0 presets from the official MyPaint brush collection; see `public/brushes/ATTRIBUTION.md`). Original PFx logo is `public/brand/Red-pfx.svg`.
- All runtime assets — styles, JS, compiled WASM, brushes and logo — are served from this repository's GitHub Pages site. No CDN, externally hosted font, remote API or image uploads.
- Completed strokes, undo/redo and clearing are saved automatically in this browser using IndexedDB, then restored when the studio opens again. The artwork and undo history stay on the device: there is no server upload. Each browser/profile has independent local artwork. Saving may be unavailable in restricted/private browser settings; check the local-save indicator and use PNG export as a separate copy. A sudden browser crash while a stroke is still in progress may lose that unfinished stroke.
- Undo/redo reconstructs the canvas by replaying recorded strokes. This is correct but may require optimization for very large artwork histories.
- A service worker caches every runtime asset after first successful visit, permitting offline revisits where supported.

## Brush and runtime assets

Additional eight raw MyPaint brush settings are copied and kept locally, pinned to upstream commit `08da4a48a4b63f2e0f3303942d7c21da8479ea9f`. Their public-domain / CC0 provenance and filenames are documented in `public/brushes/ATTRIBUTION.md`. There are no runtime calls to the upstream source.

The viewer changes only CSS transforms, preserving full 1200×800 pixel artboard coordinates, autosaved stroke positions and exported PNG pixel dimensions.

## Engine attribution

Vendored Hokusai from https://github.com/reearth/hokusai commit `f7e998173c0e7427b95afe0b6947e3103da60f00`.

Copyright Re:Earth and contributors. Dual licensed MIT OR Apache-2.0. See `vendor/hokusai/LICENSE-MIT` and `vendor/hokusai/LICENSE-APACHE`. MyPaint brush fixture files from the upstream example pack are noted as CC0 upstream. PFx adapts the WASM binding to expose `setEraser`; it does not replace the actual rendering engine.

## Start locally without external dependencies

The compiled WASM and JS runtime are checked into `pkg/`. Clone or download this repository, run `python3 -m http.server 8000`, and open `http://localhost:8000/`. It does not contact upstream repositories, package registries or a CDN to draw. Browsers do require an HTTP origin for WASM modules; direct `file://` is unsupported.

## Rebuild the engine (only for development)

Needs Rust 1.88+, the `wasm32-unknown-unknown` target and `wasm-pack`.

```sh
rustup target add wasm32-unknown-unknown
wasm-pack build vendor/hokusai/crates/hokusai-wasm --target web --release --out-dir "$PWD/pkg"
python3 -m http.server 8000
```

Open `http://localhost:8000/`. Direct `file://` launching is not supported due to native ES modules and WASM loading.

Cargo and compiler/build tooling still resolve external Rust crates at **build time**; a completely offline Rust build has not been implemented. Browser runtime is entirely self-contained.

## GitHub Pages

`.github/workflows/pages.yml` tests the Rust source, compiles the copied engine to WebAssembly, assembles all local assets and deploys automatically on pushes to `main`. Publishing source in repository settings must be **GitHub Actions**. Successful builds automatically update the `Alpha 0.1.x` badge.

Expected site: https://pfxamd.github.io/pfx-paint-studio/

## Desktop drawing pointers

Desktop mouse/pen drawing now uses a precise custom pointer: a high-contrast brush ring and centre point, dashed eraser ring, eyedropper colour marker, and open/closed hands when panning. The ring follows the **nominal MyPaint brush diameter** (base log2 radius, selected size, CSS artwork zoom). Individual MyPaint brush mappings for pressure, speed or tilt can change the actual dab footprint, so the ring is a size reference rather than an exact per-dab silhouette. The overlay uses no external images, does not capture pointer events, never appears in PNG exports, and falls back to native cursors for mobile and touch.

## Shortcuts

- B: brush; E: eraser; I: pick colour.
- Mouse wheel or + / −: zoom around pointer or view centre; Space+drag or middle-mouse+drag: pan; 0 or Fit: reset view.
- Ctrl/Cmd+Z: undo; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y: redo.

All artwork is rendered by the real compiled Hokusai brush engine, not a simulated HTML drawing brush.
