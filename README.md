# PFx Paint Studio

Local-first digital painting workspace — **Alpha 0.1.0**.

Features: Hokusai-powered real brushes, pen pressure and tilt, colours and palette, size, eraser, colour picker, undo/redo, clear, and PNG export. Designed for one screen without page scrolling.

## Runtime architecture

- Original UI, pointer input, stroke history and PNG export: `index.html`, `src/app.js`, `src/engine.js`, `src/style.css`.
- Hokusai core, `.myb` parser, in-memory tiled surface, and WASM bindings: source copied into `vendor/hokusai/`.
- Four preset `.myb` brushes are stored in `public/brushes/`. Original PFx logo is `public/brand/Red-pfx.svg`.
- All runtime assets — styles, JS, compiled WASM, brushes and logo — are served from this repository's GitHub Pages site. No CDN, externally hosted font, remote API or image uploads.
- Drawing data stays in local browser memory, not on a server. This first version does not persist artwork between page reloads. Export a PNG before leaving.
- Undo/redo reconstructs the canvas by replaying recorded strokes. This is correct but may require optimization for very large artwork histories.
- A service worker caches every runtime asset after first successful visit, permitting offline revisits where supported.

## Engine attribution

Vendored Hokusai from https://github.com/reearth/hokusai commit `f7e998173c0e7427b95afe0b6947e3103da60f00`.

Copyright Re:Earth and contributors. Dual licensed MIT OR Apache-2.0. See `vendor/hokusai/LICENSE-MIT` and `vendor/hokusai/LICENSE-APACHE`. MyPaint brush fixture files from the upstream example pack are noted as CC0 upstream. PFx adapts the WASM binding to expose `setEraser`; it does not replace the actual rendering engine.

## Build locally

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
