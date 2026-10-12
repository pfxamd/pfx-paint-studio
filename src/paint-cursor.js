/**
 * PFx Paint Studio pointer overlay.
 *
 * UI-only: never receives pointer events and never modifies stroke coordinates.
 * The ring represents the selected brush's NOMINAL dab diameter at 100% pressure:
 * MyPaint's radius_logarithmic uses the natural logarithm of the radius. Pressure,
 * tilt and brush mappings can change the rendered footprint dynamically.
 */
export class PaintCursor {
  constructor(stage, canvas, overlay, getEngine, getTool) {
    this.stage = stage;
    this.canvas = canvas;
    this.overlay = overlay;
    this.getEngine = getEngine;
    this.getTool = getTool;
    this.lastPointer = null;
    this.pointerType = null;
    this.wasVisible = false;

    stage.addEventListener("pointermove", (e) => this.onPointer(e), { capture: true });
    stage.addEventListener("pointerover", (e) => this.onPointer(e), { capture: true });
    stage.addEventListener("pointerdown", (e) => this.onPointer(e), { capture: true });
    stage.addEventListener("pointerup", (e) => this.onPointer(e), { capture: true });
    stage.addEventListener("pointercancel", () => this.hide(), { capture: true });
    stage.addEventListener("pointerleave", () => this.hide());
    stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: true });

    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") this.refresh();
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.refresh();
    });
    window.addEventListener("blur", () => this.hide());
    window.addEventListener("resize", () => this.refresh());

    const desktop = matchMedia("(min-width: 781px)");
    desktop.addEventListener("change", () => this.refresh());
  }

  get supported() {
    return matchMedia("(min-width: 781px)").matches;
  }

  onPointer(event) {
    if (!this.supported || (event.pointerType !== "mouse" && event.pointerType !== "pen")) {
      this.hide();
      return;
    }
    this.pointerType = event.pointerType;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.refresh();
  }

  onWheel(event) {
    if (!this.lastPointer) return;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.refresh();
  }

  hide() {
    this.lastPointer = null;
    this.wasVisible = false;
    this.overlay.classList.remove("visible");
    this.stage.classList.remove("cursor-active");
  }

  refresh() {
    const engine = this.getEngine();
    if (!this.lastPointer || !this.supported || !engine) {
      this.hide();
      return;
    }

    const { x, y } = this.lastPointer;
    const paper = this.canvas.getBoundingClientRect();
    // The stage and the artwork are independently transformed; only show on actual paper.
    const inside = x >= paper.left && x <= paper.right && y >= paper.top && y <= paper.bottom;
    if (!inside) {
      this.hide();
      return;
    }

    const stageRect = this.stage.getBoundingClientRect();
    const panMode = this.stage.classList.contains("panning")
      ? "grabbing"
      : this.stage.classList.contains("pan-ready") ? "grab" : null;
    const mode = panMode || this.getTool();
    this.overlay.dataset.mode = mode;

    const nominalRadius = Math.exp(engine.active.radiusLog());
    const paperPixelScale = paper.width / this.canvas.width;
    const diameter = 2 * nominalRadius * paperPixelScale;
    // Restrict the display diameter, NOT the actual engine size or exported image.
    const visualDiameter = Math.max(1.5, Math.min(1000, diameter));
    this.overlay.style.setProperty("--cursor-diameter", visualDiameter + "px");
    this.overlay.style.setProperty("--cursor-colour", engine.color);
    this.overlay.style.transform = "translate3d(" + (x - stageRect.left) +
      "px," + (y - stageRect.top) + "px,0)";
    this.wasVisible = true;
    this.overlay.classList.add("visible");
    this.stage.classList.add("cursor-active");
  }
}
