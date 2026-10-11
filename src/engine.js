import init, { HokusaiBrush, HokusaiCanvas } from "../pkg/hokusai_wasm.js";

export const BRUSHES = Object.freeze([
  { id: "charcoal", filename: "charcoal.myb", name: "Charcoal" },
  { id: "calligraphy", filename: "calligraphy.myb", name: "Ink" },
  { id: "brush", filename: "brush.myb", name: "Paint" },
  { id: "marker_fat", filename: "marker_fat.myb", name: "Marker" }
]);

function hexToHsv(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === rgb[0]) h = ((rgb[1] - rgb[2]) / delta) % 6;
    else if (max === rgb[1]) h = (rgb[2] - rgb[0]) / delta + 2;
    else h = (rgb[0] - rgb[1]) / delta + 4;
    h = (h / 6 + 1) % 1;
  }
  return [h, max === 0 ? 0 : delta / max, max];
}

function channelHex(n) {
  return n.toString(16).padStart(2, "0");
}

export class PaintingEngine {
  static async create(canvas, onHistoryChange) {
    const [wasm, sources] = await Promise.all([
      init(),
      Promise.all(BRUSHES.map(async (item) => {
        const url = new URL("../public/brushes/" + item.filename, import.meta.url);
        const response = await fetch(url);
        if (!response.ok) throw new Error("Brush unavailable: " + item.name);
        return [item.id, await response.text()];
      }))
    ]);
    return new PaintingEngine(canvas, wasm, new Map(sources), onHistoryChange);
  }

  constructor(canvas, wasm, brushSources, onHistoryChange) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!this.context) throw new Error("This browser does not support Canvas 2D.");
    this.wasm = wasm;
    this.brushSources = brushSources;
    this.surface = new HokusaiCanvas(canvas.width, canvas.height);
    this.brushId = "charcoal";
    this.color = "#1f242d";
    this.size = 0;
    this.eraser = false;
    this.active = null;
    this.history = [];
    this.redoStack = [];
    this.current = null;
    this.renderQueued = false;
    this.onHistoryChange = onHistoryChange;
    this.refreshBrush();
    this.renderNow();
  }

  createBrush(id, color, size, eraser) {
    const source = this.brushSources.get(id);
    if (!source) throw new Error("Unknown brush: " + id);
    const brush = new HokusaiBrush(source);
    const [h, s, v] = hexToHsv(color);
    brush.setColorHsv(h, s, v);
    brush.setRadiusLog(brush.radiusLog() + size);
    brush.setEraser(eraser);
    return brush;
  }

  refreshBrush() {
    if (this.active) this.active.free();
    this.active = this.createBrush(this.brushId, this.color, this.size, this.eraser);
  }

  configure({ brushId = this.brushId, color = this.color, size = this.size, eraser = this.eraser } = {}) {
    this.brushId = brushId;
    this.color = color.toLowerCase();
    this.size = Number(size);
    this.eraser = eraser;
    if (!this.current) this.refreshBrush();
  }

  sample(event, rect) {
    const x = (event.clientX - rect.left) * this.canvas.width / rect.width;
    const y = (event.clientY - rect.top) * this.canvas.height / rect.height;
    const isPen = event.pointerType === "pen";
    const pressure = isPen && event.pressure > 0 ? event.pressure : 1;
    return {
      x, y, pressure,
      xtilt: isPen ? Math.sin((event.tiltX || 0) * Math.PI / 180) : 0,
      ytilt: isPen ? Math.sin((event.tiltY || 0) * Math.PI / 180) : 0,
      time: event.timeStamp || performance.now()
    };
  }

  begin(event, rect) {
    if (this.current) return;
    this.surface.resetStroke();
    this.current = {
      brushId: this.brushId,
      color: this.color,
      size: this.size,
      eraser: this.eraser,
      points: []
    };
    this.add(event, rect);
  }

  add(event, rect) {
    if (!this.current) return;
    const point = this.sample(event, rect);
    const points = this.current.points;
    const last = points.length ? points[points.length - 1] : null;
    const dt = last ? Math.max(0.001, Math.min(0.15, (point.time - last.time) / 1000)) : 0.01;
    this.surface.strokeTo(this.active, point.x, point.y, point.pressure, point.xtilt, point.ytilt, dt);
    points.push({ ...point, dt });
    this.requestRender();
  }

  end() {
    if (!this.current) return;
    const points = this.current.points;
    if (points.length === 1) {
      const p = points[0];
      const synthetic = { ...p, x: p.x + 0.2, y: p.y + 0.2, time: p.time + 12, dt: 0.012 };
      this.surface.strokeTo(this.active, synthetic.x, synthetic.y, synthetic.pressure, synthetic.xtilt, synthetic.ytilt, synthetic.dt);
      points.push(synthetic);
    }
    this.surface.finishStroke(this.active);
    this.surface.resetStroke();
    this.history.push(this.current);
    this.redoStack = [];
    this.current = null;
    this.refreshBrush();
    this.onHistoryChange?.();
    this.requestRender();
  }

  undo() {
    if (!this.history.length || this.current) return;
    this.redoStack.push(this.history.pop());
    this.replay();
  }

  redo() {
    if (!this.redoStack.length || this.current) return;
    this.history.push(this.redoStack.pop());
    this.replay();
  }

  clear() {
    if (this.current) this.end();
    this.history = [];
    this.redoStack = [];
    this.surface.clear();
    this.onHistoryChange?.();
    this.requestRender();
  }

  replay() {
    this.surface.clear();
    const cache = new Map();
    try {
      for (const stroke of this.history) {
        const key = [stroke.brushId, stroke.color, stroke.size, stroke.eraser].join("|");
        let brush = cache.get(key);
        if (!brush) {
          brush = this.createBrush(stroke.brushId, stroke.color, stroke.size, stroke.eraser);
          cache.set(key, brush);
        }
        this.surface.resetStroke();
        for (const point of stroke.points) {
          this.surface.strokeTo(brush, point.x, point.y, point.pressure, point.xtilt, point.ytilt, point.dt);
        }
        this.surface.finishStroke(brush);
        this.surface.resetStroke();
      }
    } finally {
      for (const brush of cache.values()) brush.free();
    }
    this.onHistoryChange?.();
    this.requestRender();
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  renderNow() {
    this.surface.flush_pixels();
    const ptr = this.surface.pixelsPtr();
    const len = this.surface.pixelsLen();
    const pixels = new Uint8ClampedArray(this.wasm.memory.buffer, ptr, len);
    const image = new ImageData(pixels, this.canvas.width, this.canvas.height);
    this.context.putImageData(image, 0, 0);
  }

  pickColor(event, rect) {
    this.renderNow();
    const point = this.sample(event, rect);
    const x = Math.max(0, Math.min(this.canvas.width - 1, Math.floor(point.x)));
    const y = Math.max(0, Math.min(this.canvas.height - 1, Math.floor(point.y)));
    const data = this.context.getImageData(x, y, 1, 1).data;
    return "#" + channelHex(data[0]) + channelHex(data[1]) + channelHex(data[2]);
  }

  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
