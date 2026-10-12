import init, { HokusaiBrush, HokusaiCanvas } from "../pkg/hokusai_wasm.js";

export const BRUSHES = Object.freeze([
  { id: "charcoal", filename: "charcoal.myb", name: "Charcoal" },
  { id: "calligraphy", filename: "calligraphy.myb", name: "Ink" },
  { id: "brush", filename: "brush.myb", name: "Paint" },
  { id: "marker_fat", filename: "marker_fat.myb", name: "Marker" },
  { id: "pencil", filename: "pencil.myb", name: "Pencil" },
  { id: "dry_brush", filename: "dry_brush.myb", name: "Dry Brush" },
  { id: "textured_ink", filename: "textured_ink.myb", name: "Texture Ink" },
  { id: "watercolor_glazing", filename: "watercolor_glazing.myb", name: "Watercolour" },
  { id: "watercolor_expressive", filename: "watercolor_expressive.myb", name: "Wet Brush" },
  { id: "oil", filename: "oil.myb", name: "Oil Paint" },
  { id: "acrylic", filename: "acrylic.myb", name: "Acrylic" },
  { id: "pastel", filename: "pastel.myb", name: "Pastel" }
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
    this.inputType = null;
    this.active = null;
    this.history = [];
    this.redoStack = [];
    this.checkpoints = [];
    this.current = null;
    this.strokeRect = null;
    this.renderQueued = false;
    this.imageView = null;
    this.imageBuffer = null;
    this.imagePointer = -1;
    this.onHistoryChange = onHistoryChange;
    this.refreshBrush();
    this.renderNow();
  }

  createBrush(id, color, size, eraser, responsiveMouse = false) {
    const source = this.brushSources.get(id);
    if (!source) throw new Error("Unknown brush: " + id);
    const brush = new HokusaiBrush(source);
    const [h, s, v] = hexToHsv(color);
    brush.setColorHsv(h, s, v);
    brush.setRadiusLog(brush.radiusLog() + size);
    brush.setEraser(eraser);
    if (responsiveMouse) brush.setResponsiveMouse();
    return brush;
  }

  refreshBrush() {
    if (this.active) this.active.free();
    this.active = this.createBrush(this.brushId, this.color, this.size, this.eraser,
      this.inputType === "mouse");
  }

  configure({ brushId = this.brushId, color = this.color, size = this.size, eraser = this.eraser } = {}) {
    this.brushId = brushId;
    this.color = color.toLowerCase();
    this.size = Number(size);
    this.eraser = eraser;
    if (!this.current) this.refreshBrush();
  }

  sample(event, rect) {
    // Captured pointers may travel far beyond the artboard. Bound the
    // stroke simulation to one tile outside it, so Hokusai does not allocate
    // invisible off-canvas tiles when the mouse leaves the browser window.
    const margin = 64;
    const x = Math.max(-margin, Math.min(this.canvas.width + margin,
      (event.clientX - rect.left) * this.canvas.width / rect.width));
    const y = Math.max(-margin, Math.min(this.canvas.height + margin,
      (event.clientY - rect.top) * this.canvas.height / rect.height));
    const isPen = event.pointerType === "pen";
    // Pen lift-off is reported with pressure 0; do not turn it into a
    // full-pressure dab. Mouse and touch still use a steady default.
    const pressure = isPen && Number.isFinite(event.pressure)
      ? Math.max(0, Math.min(1, event.pressure))
      : 1;
    return {
      x, y, pressure,
      xtilt: isPen ? Math.sin((event.tiltX || 0) * Math.PI / 180) : 0,
      ytilt: isPen ? Math.sin((event.tiltY || 0) * Math.PI / 180) : 0,
      time: event.timeStamp || performance.now()
    };
  }

  begin(event, rect) {
    if (this.current) return;
    const inputType = event.pointerType || "mouse";
    if (this.inputType !== inputType) {
      this.inputType = inputType;
      this.refreshBrush();
    }
    this.strokeRect = rect;
    this.surface.resetStroke();
    this.current = {
      brushId: this.brushId,
      color: this.color,
      size: this.size,
      eraser: this.eraser,
      inputType: this.inputType,
      points: []
    };
    this.add(event, rect);
  }

  add(event, rect = this.strokeRect) {
    if (!this.current || !rect) return;
    const point = this.sample(event, rect);
    const history = this.current.points;
    const previous = history.length ? history[history.length - 1] : null;
    if (!previous) {
      this.surface.strokeTo(this.active, point.x, point.y, point.pressure, point.xtilt, point.ytilt, 0.01);
      history.push({ ...point, dt: 0.01 });
      this.requestRender();
      return;
    }

    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const pressureDelta = Math.abs(point.pressure - previous.pressure);
    const elapsed = point.time - previous.time;
    // Eliminate nearly identical coalesced samples, but preserve pressure,
    // pen tilt and dwell changes that affect artistic brush dynamics.
    // Tilt inputs are normalized to [-1, 1]; 0.001 rejects only tiny jitter.
    // Avoid extra tilt comparisons on the common mouse/touch fast path.
    if (distance < 0.04 && pressureDelta < 0.005 && elapsed < 12 &&
        (this.inputType !== "pen" ||
          (Math.abs(point.xtilt - previous.xtilt) < 0.001 &&
           Math.abs(point.ytilt - previous.ytilt) < 0.001))) return;

    // The engine places dabs on segments; bounded spatial substeps keep
    // speed-dependent strokes stable when the browser coalesces rapid movement.
    // We never average the endpoint or add trailing smoothing/lag.
    const steps = Math.min(64, Math.max(1, Math.ceil(distance / 3.5)));
    const totalDt = Math.max(0.0001, Math.min(0.15, elapsed / 1000));
    const dt = totalDt / steps;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sample = {
        x: previous.x + (point.x - previous.x) * t,
        y: previous.y + (point.y - previous.y) * t,
        pressure: previous.pressure + (point.pressure - previous.pressure) * t,
        xtilt: previous.xtilt + (point.xtilt - previous.xtilt) * t,
        ytilt: previous.ytilt + (point.ytilt - previous.ytilt) * t,
        time: previous.time + (point.time - previous.time) * t,
        dt
      };
      this.surface.strokeTo(this.active, sample.x, sample.y, sample.pressure, sample.xtilt, sample.ytilt, sample.dt);
      history.push(sample);
    }
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
    this.recordCheckpoint();
    this.current = null;
    this.strokeRect = null;
    this.refreshBrush();
    this.onHistoryChange?.();
    this.requestRender();
  }

  undo() {
    if (!this.history.length || this.current) return;
    this.redoStack.push(this.history.pop());
    this.pruneCheckpoints();
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
    this.releaseCheckpoints();
    this.surface.clear();
    this.onHistoryChange?.();
    this.requestRender();
  }

  // Cache up to three tiled-surface snapshots, every 24 completed strokes.
  // Each checkpoint can be restored without re-running the older brush dabs.
  recordCheckpoint() {
    const count = this.history.length;
    if (!count || count % 24 !== 0 || this.checkpoints.some(c => c.count === count)) return;
    this.checkpoints.push({ count, snapshot: this.surface.checkpoint() });
    while (this.checkpoints.length > 3) {
      this.checkpoints.shift().snapshot.free();
    }
  }

  pruneCheckpoints() {
    while (this.checkpoints.length && this.checkpoints[this.checkpoints.length - 1].count > this.history.length) {
      this.checkpoints.pop().snapshot.free();
    }
  }

  releaseCheckpoints() {
    for (const item of this.checkpoints) item.snapshot.free();
    this.checkpoints.length = 0;
  }

  replay() {
    this.pruneCheckpoints();
    const base = this.checkpoints[this.checkpoints.length - 1];
    if (base) this.surface.restoreCheckpoint(base.snapshot);
    else this.surface.clear();
    const cache = new Map();
    try {
      const from = base?.count || 0;
      for (let index = from; index < this.history.length; index++) {
        const stroke = this.history[index];
        const key = [stroke.brushId, stroke.color, stroke.size, stroke.eraser, stroke.inputType].join("|");
        let brush = cache.get(key);
        if (!brush) {
          brush = this.createBrush(stroke.brushId, stroke.color, stroke.size, stroke.eraser,
            stroke.inputType === "mouse");
          cache.set(key, brush);
        }
        this.surface.resetStroke();
        // Batch only saved-stroke playback: the same samples, in the same order,
        // cross JS/WASM once per stroke instead of once per sample.
        const packed = new Float64Array(stroke.points.length * 6);
        for (let p = 0, offset = 0; p < stroke.points.length; p++, offset += 6) {
          const point = stroke.points[p];
          packed[offset] = point.x;
          packed[offset + 1] = point.y;
          packed[offset + 2] = point.pressure;
          packed[offset + 3] = point.xtilt;
          packed[offset + 4] = point.ytilt;
          packed[offset + 5] = point.dt;
        }
        this.surface.strokePath(brush, packed);
        this.surface.finishStroke(brush);
        this.surface.resetStroke();
        if ((index + 1) % 24 === 0) this.recordCheckpointFor(index + 1);
      }
    } finally {
      for (const brush of cache.values()) brush.free();
    }
    this.onHistoryChange?.();
    this.requestRender();
  }

  recordCheckpointFor(count) {
    if (this.checkpoints.some(c => c.count === count)) return;
    this.checkpoints.push({ count, snapshot: this.surface.checkpoint() });
    while (this.checkpoints.length > 3) this.checkpoints.shift().snapshot.free();
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderDirty();
    });
  }

  // Reuse the WASM memory view and ImageData until memory grows.
  // Browser puts only the updated rectangle, without allocating a 3.8MB
  // Uint8ClampedArray wrapper on every animation frame.
  getImageView() {
    const buffer = this.wasm.memory.buffer;
    const ptr = this.surface.pixelsPtr();
    if (this.imageView && this.imageBuffer === buffer && this.imagePointer === ptr) {
      return this.imageView;
    }
    const pixels = new Uint8ClampedArray(buffer, ptr, this.surface.pixelsLen());
    this.imageView = new ImageData(pixels, this.canvas.width, this.canvas.height);
    this.imageBuffer = buffer;
    this.imagePointer = ptr;
    return this.imageView;
  }

  renderDirty() {
    const dirty = this.surface.flushDirtyPixels();
    if (dirty.length !== 4) return;
    const [x, y, width, height] = dirty;
    if (!width || !height) return;
    this.context.putImageData(this.getImageView(), 0, 0, x, y, width, height);
  }

  renderNow() {
    this.surface.flush_pixels();
    this.context.putImageData(this.getImageView(), 0, 0);
  }

  pickColor(event, rect) {
    this.renderDirty();
    const point = this.sample(event, rect);
    const x = Math.max(0, Math.min(this.canvas.width - 1, Math.floor(point.x)));
    const y = Math.max(0, Math.min(this.canvas.height - 1, Math.floor(point.y)));
    const data = this.context.getImageData(x, y, 1, 1).data;
    return "#" + channelHex(data[0]) + channelHex(data[1]) + channelHex(data[2]);
  }

  snapshot() {
    // Clone completed strokes before asynchronous persistence begins.
    return {
      width: this.canvas.width,
      height: this.canvas.height,
      history: structuredClone(this.history),
      redoStack: structuredClone(this.redoStack)
    };
  }

  restoreArtwork(saved) {
    if (this.current) throw new Error("Cannot restore during a stroke");
    this.releaseCheckpoints();
    this.history = saved.history;
    this.redoStack = saved.redoStack;
    this.replay();
    this.renderNow();
  }

  previewBrush(id, preview) {
    const width = preview.width, height = preview.height;
    const paper = new HokusaiCanvas(width, height);
    const brush = this.createBrush(id, "#242735", 0, false);
    try {
      paper.resetStroke();
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        paper.strokeTo(brush, 10 + t * (width - 20),
          height * (0.58 - 0.17 * Math.sin(t * Math.PI * 2)),
          0.35 + 0.65 * Math.sin(Math.PI * t), 0, 0, 0.02);
      }
      paper.finishStroke(brush);
      paper.flush_pixels();
      const bytes = new Uint8Array(this.wasm.memory.buffer, paper.pixelsPtr(), paper.pixelsLen());
      const rgba = new Uint8ClampedArray(bytes.length);
      for (let i = 0; i < bytes.length; i += 4) {
        const amount = 255 - (bytes[i] + bytes[i + 1] + bytes[i + 2]) / 3;
        rgba[i] = 230;
        rgba[i + 1] = 227;
        rgba[i + 2] = 221;
        rgba[i + 3] = Math.min(255, Math.round(Math.sqrt(Math.max(0, amount) / 255) * 305));
      }
      preview.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
    } finally {
      brush.free();
      paper.free();
    }
  }

  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
