// Independent visual baseline using the packaged upstream C libmypaint.
// Pin identical source brushes and pointer samples against PFx/Hokusai.
#include <libmypaint/mypaint-brush.h>
#include <libmypaint/mypaint-fixed-tiled-surface.h>
#include <libmypaint/mypaint-tiled-surface.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

enum { W = 320, H = 180 };
static float clamp01(float v) { return fmaxf(0.0f, fminf(1.0f, v)); }
static unsigned char srgb(double linear) {
  double v = fmax(0, fmin(1, linear));
  v = v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
  return (unsigned char)floor(v * 255.0 + 0.5);
}
static char *read_file(const char *path) {
  FILE *fp = fopen(path, "rb");
  if (!fp) return NULL;
  if (fseek(fp, 0, SEEK_END)) { fclose(fp); return NULL; }
  long n = ftell(fp);
  if (n <= 0 || n > 500000) { fclose(fp); return NULL; }
  rewind(fp);
  char *s = malloc((size_t)n + 1);
  if (!s || fread(s, 1, n, fp) != (size_t)n) {
    free(s); fclose(fp); return NULL;
  }
  s[n] = 0;
  fclose(fp);
  return s;
}
static void clear_surface(MyPaintTiledSurface *s) {
  for (int ty = 0; ty < (H+63)/64; ty++) {
    for (int tx = 0; tx < (W+63)/64; tx++) {
      MyPaintTileRequest req;
      mypaint_tile_request_init(&req, 0, tx, ty, FALSE);
      mypaint_tiled_surface_tile_request_start(s, &req);
      for (int i = 0; i < 64*64*4; i++) req.buffer[i] = 0;
      mypaint_tiled_surface_tile_request_end(s, &req);
    }
  }
}
static int save_ppm(MyPaintTiledSurface *s, const char *path) {
  FILE *fp = fopen(path, "wb");
  if (!fp) return 0;
  fprintf(fp, "P6\n%d %d\n255\n", W, H);
  for (int y = 0; y < H; y++) {
    for (int tx = 0; tx < (W+63)/64; tx++) {
      MyPaintTileRequest req;
      mypaint_tile_request_init(&req, 0, tx, y/64, TRUE);
      mypaint_tiled_surface_tile_request_start(s, &req);
      for (int x = tx*64; x < (tx+1)*64 && x < W; x++) {
        const uint16_t *p = &req.buffer[((y%64)*64+(x%64))*4];
        double alpha = p[3]/32768.0;
        for (int k = 0; k < 3; k++) {
          // Premultiplied linear RGB composited over white, then encoded.
          unsigned char byte = srgb(p[k]/32768.0 + 1.0 - alpha);
          fputc(byte, fp);
        }
      }
      mypaint_tiled_surface_tile_request_end(s, &req);
    }
  }
  return fclose(fp) == 0;
}
int main(int argc, char **argv) {
  if (argc != 3) { fprintf(stderr,"Usage: ref BRUSH.myb out.ppm\n"); return 2; }
  char *json = read_file(argv[1]);
  if (!json) return 3;
  MyPaintBrush *brush = mypaint_brush_new();
  if (!brush || !mypaint_brush_from_string(brush, json)) {
    fprintf(stderr,"Could not load upstream brush %s\n",argv[1]); return 4;
  }
  free(json);
  mypaint_brush_set_base_value(brush, MYPAINT_BRUSH_SETTING_COLOR_H, 0.6f);
  mypaint_brush_set_base_value(brush, MYPAINT_BRUSH_SETTING_COLOR_S, 0.7f);
  mypaint_brush_set_base_value(brush, MYPAINT_BRUSH_SETTING_COLOR_V, 0.8f);
  MyPaintFixedTiledSurface *fixed = mypaint_fixed_tiled_surface_new(W,H);
  if (!fixed) return 5;
  MyPaintSurface *surface = mypaint_fixed_tiled_surface_interface(fixed);
  clear_surface((MyPaintTiledSurface*)surface);
  mypaint_surface_begin_atomic(surface);
  float x=24, y=90, p=0.2f;
  for (int i=0; i<=40; i++) {
    x = 24.0f + i*6.0f;
    y = 90.0f + 12.0f*sinf(i*0.25f);
    p = clamp01(0.25f + 0.6f*fabsf(sinf(i*0.09f)));
    mypaint_brush_stroke_to(brush,surface,x,y,p,0,0,i?0.015:0.01);
  }
  for (int i=0;i<8;i++)
    mypaint_brush_stroke_to(brush,surface,x,y,p,0,0,0.016);
  MyPaintRectangle rect={0,0,W,H};
  mypaint_surface_end_atomic(surface,&rect);
  int ok=save_ppm((MyPaintTiledSurface*)surface,argv[2]);
  mypaint_brush_unref(brush);
  mypaint_surface_unref(surface);
  return ok ? 0 : 6;
}
