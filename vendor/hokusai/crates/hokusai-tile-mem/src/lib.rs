//! Reference [`TiledSurface`] implementation backed by a `HashMap` of tiles.
//!
//! This is the canonical surface used for compatibility tests against
//! libmypaint — `tiny-skia` and other backends defer to the same default
//! `draw_dab`/`get_color` in `hokusai-core`, so all backends produce
//! identical pixels here.

use std::collections::{HashMap, HashSet};

use hokusai_core::tile::{empty_tile, TilePixels};
use hokusai_core::TiledSurface;

#[derive(Default, Clone)]
pub struct MemSurface {
    tiles: HashMap<(i32, i32), Box<TilePixels>>,
    dirty: HashSet<(i32, i32)>,
    /// Accumulate tiles written between browser presentation frames.
    modified: HashSet<(i32, i32)>,
    in_atomic: bool,
}

impl MemSurface {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn tile(&self, tx: i32, ty: i32) -> Option<&TilePixels> {
        self.tiles.get(&(tx, ty)).map(|b| &**b)
    }

    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }

    /// Portable, exact fix15 tile representation for optional browser-local
    /// replay acceleration. No browser-visible RGBA conversion is involved.
    pub fn export_tiles(&self, width: u32, height: u32) -> Vec<u8> {
        const TILE_BYTES: usize = 64 * 64 * 4 * 2;
        let mut output = Vec::with_capacity(20 + self.tiles.len() * (8 + TILE_BYTES));
        output.extend_from_slice(b"PFXT");
        output.extend_from_slice(&1u32.to_le_bytes());
        output.extend_from_slice(&width.to_le_bytes());
        output.extend_from_slice(&height.to_le_bytes());
        output.extend_from_slice(&(self.tiles.len() as u32).to_le_bytes());
        let mut keys: Vec<_> = self.tiles.keys().copied().collect();
        keys.sort_unstable();
        for (x, y) in keys {
            output.extend_from_slice(&x.to_le_bytes());
            output.extend_from_slice(&y.to_le_bytes());
            for row in self.tiles[&(x, y)].iter() {
                for pixel in row.iter() {
                    for channel in pixel {
                        output.extend_from_slice(&channel.to_le_bytes());
                    }
                }
            }
        }
        output
    }

    /// Decode untrusted local cache data atomically. Never partially update a
    /// surface; corrupted/obsolete caches must fall back to stroke replay.
    pub fn import_tiles(data: &[u8], width: u32, height: u32) -> Option<Self> {
        const TILE_BYTES: usize = 64 * 64 * 4 * 2;
        const HEADER: usize = 20;
        const RECORD: usize = 8 + TILE_BYTES;
        if data.len() < HEADER || &data[0..4] != b"PFXT" {
            return None;
        }
        let read_u32 = |offset: usize| -> u32 {
            u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
        };
        if read_u32(4) != 1 || read_u32(8) != width || read_u32(12) != height {
            return None;
        }
        let count = read_u32(16) as usize;
        let max_tiles = ((width as usize / 64) + 4)
            .checked_mul((height as usize / 64) + 4)?;
        if count > max_tiles ||
            HEADER.checked_add(count.checked_mul(RECORD)?)? != data.len() {
            return None;
        }
        let mut result = Self::new();
        let max_x = (width as i32 + 63) / 64 + 1;
        let max_y = (height as i32 + 63) / 64 + 1;
        for index in 0..count {
            let offset = HEADER + index * RECORD;
            let tx = i32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
            let ty = i32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap());
            if !(-2..=max_x).contains(&tx) || !(-2..=max_y).contains(&ty)
                || result.tiles.contains_key(&(tx, ty)) {
                return None;
            }
            let mut tile = empty_tile();
            let mut pos = offset + 8;
            for row in tile.iter_mut() {
                for pixel in row.iter_mut() {
                    for channel in pixel.iter_mut() {
                        let value = u16::from_le_bytes([data[pos], data[pos + 1]]);
                        if value > 32768 { return None; }
                        *channel = value;
                        pos += 2;
                    }
                }
            }
            result.tiles.insert((tx, ty), tile);
            result.modified.insert((tx, ty));
        }
        Some(result)
    }

    /// Drain pixels touched by the brush, independent of atomic boundaries.
    pub fn take_modified_tiles(&mut self) -> Vec<(i32, i32)> {
        self.modified.drain().collect()
    }
}

impl TiledSurface for MemSurface {
    fn tile_request_start(&mut self, tx: i32, ty: i32) -> &mut TilePixels {
        self.modified.insert((tx, ty));
        if self.in_atomic {
            self.dirty.insert((tx, ty));
        }
        self.tiles.entry((tx, ty)).or_insert_with(empty_tile)
    }

    fn tile_request_end(&mut self, _tx: i32, _ty: i32) {}

    fn tile_lookup(&self, tx: i32, ty: i32) -> Option<&TilePixels> {
        self.tiles.get(&(tx, ty)).map(|b| &**b)
    }

    fn begin_atomic(&mut self) {
        self.in_atomic = true;
        self.dirty.clear();
    }

    fn end_atomic(&mut self) -> Vec<(i32, i32)> {
        self.in_atomic = false;
        self.dirty.drain().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hokusai_core::tile::TILE_SIZE;

    #[test]
    fn tile_cache_roundtrips_exact_fix15_pixels_and_rejects_corruption() {
        let mut surface = MemSurface::new();
        for (tx, ty, value) in [(0, 0, 32768), (4, 3, 10032), (-1, 0, 4096)] {
            let tile = surface.tile_request_start(tx, ty);
            tile[0][0] = [value, 42, 128, value];
            tile[63][63] = [256, value, 0, value];
        }
        let encoded = surface.export_tiles(320, 240);
        let restored = MemSurface::import_tiles(&encoded, 320, 240).unwrap();
        assert_eq!(restored.export_tiles(320, 240), encoded);
        assert_eq!(restored.tile_count(), 3);
        assert!(MemSurface::import_tiles(&encoded, 640, 240).is_none());

        let mut bad = encoded.clone();
        bad[0] = 0;
        assert!(MemSurface::import_tiles(&bad, 320, 240).is_none());
        let mut truncated = encoded.clone();
        truncated.pop();
        assert!(MemSurface::import_tiles(&truncated, 320, 240).is_none());
        let mut bad_channel = encoded.clone();
        bad_channel[28] = 255;
        bad_channel[29] = 255;
        assert!(MemSurface::import_tiles(&bad_channel, 320, 240).is_none());

        let mut duplicate = encoded.clone();
        let second = 20 + 8 + 64 * 64 * 8;
        let first_coord = duplicate[20..28].to_vec();
        duplicate[second..second + 8].copy_from_slice(&first_coord);
        assert!(MemSurface::import_tiles(&duplicate, 320, 240).is_none());
    }

    #[test]
    fn lends_and_records_dirty() {
        let mut s = MemSurface::new();
        s.begin_atomic();
        {
            let t = s.tile_request_start(2, -1);
            t[0][0] = [1, 2, 3, 4];
            s.tile_request_end(2, -1);
        }
        let dirty = s.end_atomic();
        assert_eq!(dirty, vec![(2, -1)]);
        assert_eq!(s.tile(2, -1).unwrap()[0][0], [1, 2, 3, 4]);
        assert_eq!(s.tile(0, 0), None);
        assert_eq!(s.take_modified_tiles(), vec![(2, -1)]);
        assert!(s.take_modified_tiles().is_empty());
        let _ = TILE_SIZE;
    }
}
