//! `wasm-bindgen` bindings for the hokusai brush engine.
//!
//! Exposes three JS-facing types:
//! - [`HokusaiBrush`] — parsed `.myb` brush
//! - [`HokusaiCanvas`] — owns the tile-backed surface plus a `BrushState`
//!   for the in-flight stroke, and produces RGBA8 pixel data for
//!   `ImageData.data.set()`
//!
//! Build with:
//! ```sh
//! wasm-pack build crates/hokusai-wasm --target web --release
//! ```
//! or invoke `wasm-bindgen` directly after `cargo build --target
//! wasm32-unknown-unknown --release -p hokusai-wasm`.

#![allow(clippy::needless_range_loop)]

use hokusai_brush as myb;
use hokusai_core::color::linear_to_srgb;
use hokusai_core::tile::TILE_SIZE;
use hokusai_core::{fix15, Brush, BrushState};
use hokusai_tile_mem::MemSurface;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct HokusaiBrush {
    inner: Brush,
}

#[wasm_bindgen]
impl HokusaiBrush {
    /// Parse a `.myb` JSON document.
    #[wasm_bindgen(constructor)]
    pub fn new(myb_json: &str) -> Result<HokusaiBrush, JsError> {
        let inner = myb::from_str(myb_json).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Self { inner })
    }

    /// Override the HSV base colour (each channel in [0, 1]).
    #[wasm_bindgen(js_name = setColorHsv)]
    pub fn set_color_hsv(&mut self, h: f32, s: f32, v: f32) {
        self.inner
            .get_mut(hokusai_core::BrushSetting::ColorH)
            .base_value = h;
        self.inner
            .get_mut(hokusai_core::BrushSetting::ColorS)
            .base_value = s;
        self.inner
            .get_mut(hokusai_core::BrushSetting::ColorV)
            .base_value = v;
    }

    /// Override the base radius (libmypaint's `radius_logarithmic`, log2 px).
    #[wasm_bindgen(js_name = setRadiusLog)]
    pub fn set_radius_log(&mut self, log2_radius: f32) {
        self.inner
            .get_mut(hokusai_core::BrushSetting::Radius)
            .base_value = log2_radius;
    }

    /// Toggle erasing while preserving the selected brush's spacing and shape.
    #[wasm_bindgen(js_name = setEraser)]
    pub fn set_eraser(&mut self, enabled: bool) {
        self.inner
            .get_mut(hokusai_core::BrushSetting::Eraser)
            .base_value = if enabled { 1.0 } else { 0.0 };
    }

    /// Keep mouse input responsive without changing the original brush preset.
    /// Only the slow-tracking base is capped; per-dab brush character remains.
    #[wasm_bindgen(js_name = setResponsiveMouse)]
    pub fn set_responsive_mouse(&mut self) {
        let tracking = self.inner.get_mut(hokusai_core::BrushSetting::SlowTracking);
        tracking.base_value = tracking.base_value.min(0.6);
    }

    /// Read the brush's designed radius (its `radius_logarithmic` base
    /// value). Useful for UIs that want to offset from the natural size
    /// rather than override it outright.
    #[wasm_bindgen(js_name = radiusLog)]
    pub fn radius_log(&self) -> f32 {
        self.inner
            .get(hokusai_core::BrushSetting::Radius)
            .base_value
    }
}

/// A compact in-memory checkpoint of the brush surface. This never leaves the
/// browser, and excludes the full RGBA preview buffer.
#[wasm_bindgen]
pub struct HokusaiCheckpoint {
    surface: MemSurface,
    state: BrushState,
}

// Reuse the exact sRGB result for repeated floating-point channel values.
// Keys are full f32 bit patterns: cache hits cannot change pixel rounding.
const SRGB_CACHE_SIZE: usize = 2048;
const SRGB_LUT_STEPS: usize = 4096;
static SRGB_LUT: std::sync::OnceLock<[u8; SRGB_LUT_STEPS + 1]> =
    std::sync::OnceLock::new();

#[inline]
fn exact_srgb_byte(linear: f32) -> u8 {
    (linear_to_srgb(linear).clamp(0.0, 1.0) * 255.0).round() as u8
}

// The 8-bit transfer function is monotonic. When two successive LUT
// boundaries round to the same byte, *every* input between them returns
// that byte. Boundary-crossing bins retain the original exact conversion.
#[inline]
fn srgb_byte_without_powf_when_safe(linear: f32) -> u8 {
    if !(0.0..=1.0).contains(&linear) {
        return exact_srgb_byte(linear);
    }
    let lut = SRGB_LUT.get_or_init(|| {
        std::array::from_fn(|i| exact_srgb_byte(i as f32 / SRGB_LUT_STEPS as f32))
    });
    let index = (linear * SRGB_LUT_STEPS as f32) as usize;
    if index >= SRGB_LUT_STEPS {
        return lut[SRGB_LUT_STEPS];
    }
    if lut[index] == lut[index + 1] {
        lut[index]
    } else {
        exact_srgb_byte(linear)
    }
}

struct SrgbCache {
    keys: [u32; SRGB_CACHE_SIZE],
    values: [u8; SRGB_CACHE_SIZE],
}

impl SrgbCache {
    fn new() -> Self {
        Self {
            keys: [u32::MAX; SRGB_CACHE_SIZE],
            values: [0; SRGB_CACHE_SIZE],
        }
    }

    #[inline]
    fn encode(&mut self, linear: f32) -> u8 {
        let key = linear.to_bits();
        let slot = (key.wrapping_mul(0x9E37_79B1) >> 21) as usize;
        if self.keys[slot] == key {
            return self.values[slot];
        }
        let value = srgb_byte_without_powf_when_safe(linear);
        self.keys[slot] = key;
        self.values[slot] = value;
        value
    }
}

#[cfg(test)]
mod srgb_cache_tests {
    use super::*;

    #[test]
    fn cached_output_is_byte_exact_for_repeated_and_colliding_channels() {
        let mut cache = SrgbCache::new();
        // Exercise channel/alpha combinations across the fixed15 gamut,
        // including repeated inputs and hash-slot collisions.
        for n in 0..100_000u32 {
            let a = (n.wrapping_mul(197) % 32_769) as f32 / 32_768.0;
            let premul = (n.wrapping_mul(311) % 32_769) as f32 / 32_768.0;
            let value = if a == 0.0 {
                1.0
            } else {
                let channel = premul.min(a);
                (channel / a) * a + (1.0 - a)
            };
            let expected = (linear_to_srgb(value).clamp(0.0, 1.0) * 255.0).round() as u8;
            assert_eq!(cache.encode(value), expected);
            assert_eq!(cache.encode(value), expected);
        }
    }

    #[test]
    fn lookup_matches_original_near_every_output_boundary() {
        let mut cache = SrgbCache::new();
        // Every 8-bit sRGB transition, including immediately adjacent f32
        // values where rounding differences could affect the final byte.
        for byte in 0..255u32 {
            let srgb = (byte as f64 + 0.5) / 255.0;
            let linear = if srgb <= 0.04045 {
                srgb / 12.92
            } else {
                ((srgb + 0.055) / 1.055).powf(2.4)
            } as f32;
            for shift in -32i64..=32 {
                let bits = linear.to_bits() as i64 + shift;
                if bits < 0 || bits > u32::MAX as i64 { continue; }
                let value = f32::from_bits(bits as u32);
                assert_eq!(cache.encode(value), exact_srgb_byte(value),
                    "Mismatch at byte boundary {byte} value {value}");
            }
        }
        for step in 0..=1_000_000 {
            let value = step as f32 / 1_000_000.0;
            assert_eq!(cache.encode(value), exact_srgb_byte(value));
        }
    }
}

/// A drawable canvas. Holds the tiled surface, an active [`BrushState`],
/// and the RGBA8 output buffer reused across `pixels()` calls.
#[wasm_bindgen]
pub struct HokusaiCanvas {
    surface: MemSurface,
    state: BrushState,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    needs_full_flush: bool,
    srgb_cache: SrgbCache,
}

#[wasm_bindgen]
impl HokusaiCanvas {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> HokusaiCanvas {
        let mut pixels = vec![255u8; (width * height * 4) as usize];
        // Fill alpha = 255 explicitly (already done by `vec![255; …]`, but be
        // explicit about it for readers).
        for px in pixels.chunks_exact_mut(4) {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
            px[3] = 255;
        }
        Self {
            surface: MemSurface::new(),
            state: BrushState::default(),
            width,
            height,
            pixels,
            needs_full_flush: true,
            srgb_cache: SrgbCache::new(),
        }
    }

    /// Clone the tiled surface and brush state after a completed stroke.
    #[wasm_bindgen(js_name = checkpoint)]
    pub fn checkpoint(&self) -> HokusaiCheckpoint {
        HokusaiCheckpoint {
            surface: self.surface.clone(),
            state: self.state.clone(),
        }
    }

    /// Restore a known tile checkpoint, invalidating the full output buffer.
    #[wasm_bindgen(js_name = restoreCheckpoint)]
    pub fn restore_checkpoint(&mut self, saved: &HokusaiCheckpoint) {
        self.surface = saved.surface.clone();
        self.state = saved.state.clone();
        self.needs_full_flush = true;
    }

    /// Flush `slow_tracking` lag so the stroke's trailing pixels are painted.
    /// Call on pointer-up *before* resetting.
    #[wasm_bindgen(js_name = finishStroke)]
    pub fn finish_stroke(&mut self, brush: &HokusaiBrush) {
        brush
            .inner
            .finish_stroke(&mut self.state, &mut self.surface);
    }

    /// End the current stroke so the next `strokeTo` starts fresh.
    #[wasm_bindgen(js_name = resetStroke)]
    pub fn reset_stroke(&mut self) {
        self.state.reset();
    }

    /// Drop all painted tiles and reset stroke state. Cheaper and safer than
    /// reconstructing the canvas object on the JS side.
    pub fn clear(&mut self) {
        self.surface = MemSurface::new();
        self.state.reset();
        self.needs_full_flush = true;
    }

    /// Feed one pointer event. `dtime` is seconds since the previous call.
    ///
    /// `xtilt` / `ytilt` are pen tilt in [-1, 1], matching libmypaint's
    /// convention. Pass 0 for devices that don't report tilt.
    #[wasm_bindgen(js_name = strokeTo)]
    #[allow(clippy::too_many_arguments)]
    pub fn stroke_to(
        &mut self,
        brush: &HokusaiBrush,
        x: f32,
        y: f32,
        pressure: f32,
        xtilt: f32,
        ytilt: f32,
        dtime: f64,
    ) {
        brush.inner.stroke_to(
            &mut self.state,
            &mut self.surface,
            x,
            y,
            pressure,
            xtilt,
            ytilt,
            dtime,
        );
    }

    /// Return the canvas as RGBA8 in sRGB, composited over white.
    /// JS copies via `ImageData.data.set(canvas.pixels())`. wasm-bindgen
    /// can't return a borrowed slice across the JS boundary, so the
    /// `Vec<u8>` materialisation is forced; the underlying `flatten` writes
    /// in-place into the canvas's own buffer first, so the per-frame cost
    /// is one memcpy into the JS Uint8Array.
    pub fn pixels(&mut self) -> Vec<u8> {
        flatten(&self.surface, self.width, self.height, &mut self.pixels, &mut self.srgb_cache);
        self.pixels.clone()
    }

    /// Pointer + length accessors for callers that want to skip the
    /// `pixels()` copy entirely: JS can construct
    /// `new Uint8Array(memory.buffer, canvas.pixels_ptr(),
    /// canvas.pixels_len())` and `ImageData.data.set` directly from
    /// wasm memory. Call `flush_pixels()` first to refresh the buffer.
    pub fn flush_pixels(&mut self) {
        flatten(&self.surface, self.width, self.height, &mut self.pixels, &mut self.srgb_cache);
        self.surface.take_modified_tiles();
        self.needs_full_flush = false;
    }

    /// Update only tiles affected since the last flush. Returns a small
    /// [x, y, width, height] dirty region in artwork pixel coordinates.
    /// Empty means no visible pixel data has changed.
    #[wasm_bindgen(js_name = flushDirtyPixels)]
    pub fn flush_dirty_pixels(&mut self) -> Vec<u32> {
        if self.needs_full_flush {
            self.flush_pixels();
            return vec![0, 0, self.width, self.height];
        }
        let modified = self.surface.take_modified_tiles();
        let mut left = self.width as i32;
        let mut top = self.height as i32;
        let mut right = 0i32;
        let mut bottom = 0i32;
        let size = TILE_SIZE as i32;
        for (tx, ty) in modified {
            let x = tx * size;
            let y = ty * size;
            // Tiles can extend beyond the artwork; ignore off-canvas edits.
            if x >= self.width as i32 || y >= self.height as i32 || x + size <= 0 || y + size <= 0 {
                continue;
            }
            raster_tile(&self.surface, self.width, self.height, &mut self.pixels, tx, ty, &mut self.srgb_cache);
            left = left.min(x.max(0));
            top = top.min(y.max(0));
            right = right.max((x + size).min(self.width as i32));
            bottom = bottom.max((y + size).min(self.height as i32));
        }
        if right <= left || bottom <= top {
            Vec::new()
        } else {
            vec![left as u32, top as u32, (right - left) as u32, (bottom - top) as u32]
        }
    }

    #[wasm_bindgen(js_name = pixelsPtr)]
    pub fn pixels_ptr(&self) -> *const u8 {
        self.pixels.as_ptr()
    }

    #[wasm_bindgen(js_name = pixelsLen)]
    pub fn pixels_len(&self) -> usize {
        self.pixels.len()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
}

fn flatten(surface: &MemSurface, w: u32, h: u32, out: &mut [u8], cache: &mut SrgbCache) {
    // Full frame for export, colour sampling, initial render and undo.
    out.fill(255);
    let ts = TILE_SIZE as i32;
    for ty in 0..(h as i32 + ts - 1) / ts {
        for tx in 0..(w as i32 + ts - 1) / ts {
            raster_tile(surface, w, h, out, tx, ty, cache);
        }
    }
}

fn raster_tile(surface: &MemSurface, w: u32, h: u32, out: &mut [u8], tx: i32, ty: i32, cache: &mut SrgbCache) {
    let Some(tile) = surface.tile(tx, ty) else {
        return;
    };
    let ts = TILE_SIZE as i32;
    for ly in 0..TILE_SIZE {
        let wy = ty * ts + ly as i32;
        if wy < 0 || wy >= h as i32 {
            continue;
        }
        for lx in 0..TILE_SIZE {
            let wx = tx * ts + lx as i32;
            if wx < 0 || wx >= w as i32 {
                continue;
            }
            let p = tile[ly][lx];
            let idx = ((wy as u32 * w + wx as u32) * 4) as usize;
            let a = fix15::to_f32(p[3]);
            if a <= 0.0 {
                out[idx] = 255;
                out[idx + 1] = 255;
                out[idx + 2] = 255;
                out[idx + 3] = 255;
                continue;
            }
            let r = fix15::to_f32(p[0]) / a;
            let g = fix15::to_f32(p[1]) / a;
            let b = fix15::to_f32(p[2]) / a;
            let or = r * a + (1.0 - a);
            let og = g * a + (1.0 - a);
            let ob = b * a + (1.0 - a);
            out[idx] = cache.encode(or);
            out[idx + 1] = cache.encode(og);
            out[idx + 2] = cache.encode(ob);
            out[idx + 3] = 255;
        }
    }
}

// Panic hook: only meaningful in the browser, so gate the whole thing
// to wasm32 to keep native test builds lint-clean.
#[cfg(all(target_arch = "wasm32", not(feature = "small-panic")))]
#[wasm_bindgen(start)]
pub fn start() {
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console)]
        fn error(s: &str);
    }
    std::panic::set_hook(Box::new(|info| {
        error(&format!("hokusai panic: {info}"));
    }));
}
