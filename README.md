# PFx Paint Studio

Local-first digital painting workspace — **Alpha 0.1.0**.

Features: Hokusai-powered real brushes, pen pressure and tilt, colours and palette, size, eraser, colour picker, undo/redo, clear, and PNG export. Designed for one screen without page scrolling.

## Runtime architecture

- Original UI, pointer input, stroke history and PNG export: `index.html`, `src/app.js`, `src/engine.js`, `src/style.css`.
- Hokusai core, `.myb` parser, in-memory tiled surface, and WASM bindings: source copied into `vendor/hokusai/`.
- Four preset `.myb` brushes are stored in `public/brushes/`. Original PFx logo is `public/brand/Red-pfx.svg`.
- All runtime assets — styles, JS, compiled WASM, brushes and logo — are served from this repository's GitHub Pages site. No CDN, externally hosted font, remote API or image uploads.
- Completed strokes, undo/redo and clearing are saved automatically in this browser using IndexedDB, then restored when the studio opens again. The artwork and undo history stay on the device: there is no server upload. Each browser/profile has independent local artwork. Saving may be unavailable in restricted/private browser settings; check the local-save indicator and use PNG export as a separate copy. A sudden browser crash while a stroke is still in progress may lose that unfinished stroke.
- Undo/redo reconstructs the canvas by replaying recorded strokes. This is correct but may require optimization for very large artwork histories.
- A service worker caches every runtime asset after first successful visit, permitting offline revisits where supported.

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

## Shortcuts

- B: brush; E: eraser; I: pick colour.
- Ctrl/Cmd+Z: undo; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y: redo.

All artwork is rendered by the real compiled Hokusai brush engine, not a simulated HTML drawing brush.
