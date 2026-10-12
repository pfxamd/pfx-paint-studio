const MIN_SCALE = 1;
const MAX_SCALE = 8;

export class CanvasViewport {
  constructor(stage, frame, zoomLabel, busy = () => false) {
    this.stage = stage;
    this.frame = frame;
    this.label = zoomLabel;
    this.busy = busy;
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.spaceDown = false;
    this.drag = null;
    stage.addEventListener("wheel", (e) => {
      if (this.busy()) return;
      e.preventDefault();
      // Use a consistent exponential response for wheel mice and touchpads.
      const delta = e.deltaY * (e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 300 : 1);
      this.zoom(this.scale * Math.exp(-delta * 0.0014), e.clientX, e.clientY);
    }, { passive: false });
    stage.addEventListener("pointerdown", (e) => {
      if (this.busy() || this.drag || !(e.button === 1 || (this.spaceDown && e.button === 0))) return;
      e.preventDefault();
      e.stopPropagation();
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, initialX: this.x, initialY: this.y };
      stage.classList.add("panning");
      stage.setPointerCapture(e.pointerId);
    }, true);
    stage.addEventListener("pointermove", (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      this.x = this.drag.initialX + e.clientX - this.drag.x;
      this.y = this.drag.initialY + e.clientY - this.drag.y;
      this.clamp();
      this.render();
    }, true);
    for (const type of ["pointerup", "pointercancel"]) {
      stage.addEventListener(type, (e) => {
        if (!this.drag || this.drag.id !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        this.endPan();
      }, true);
    }
    stage.addEventListener("lostpointercapture", (e) => {
      if (this.drag?.id === e.pointerId) this.endPan();
    });
    window.addEventListener("keydown", (e) => {
      const target = e.target;
      const inControl = target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(target.tagName));
      if (inControl || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        this.spaceDown = true;
        stage.classList.add("pan-ready");
      } else if (e.key === "0") {
        this.fit();
      } else if (e.key === "+" || e.key === "=") {
        this.zoom(this.scale * 1.25);
      } else if (e.key === "-") {
        this.zoom(this.scale / 1.25);
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        this.spaceDown = false;
        stage.classList.remove("pan-ready");
      }
    });
    window.addEventListener("blur", () => {
      this.spaceDown = false;
      stage.classList.remove("pan-ready");
      this.endPan();
    });
    window.addEventListener("resize", () => { this.clamp(); this.render(); });
    this.render();
  }

  endPan() {
    if (!this.drag) return;
    const pointerId = this.drag.id;
    this.drag = null;
    this.stage.classList.remove("panning");
    if (this.stage.hasPointerCapture(pointerId)) this.stage.releasePointerCapture(pointerId);
  }

  clamp() {
    // Keep a useful part of the artboard within the visible viewport.
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    const maxX = Math.max(0, (w + this.frame.offsetWidth * this.scale) / 2 - 75);
    const maxY = Math.max(0, (h + this.frame.offsetHeight * this.scale) / 2 - 55);
    this.x = Math.max(-maxX, Math.min(maxX, this.x));
    this.y = Math.max(-maxY, Math.min(maxY, this.y));
  }

  zoom(value, clientX, clientY) {
    if (this.busy()) return;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
    if (Math.abs(next - this.scale) < 0.0001) return;
    const rect = this.stage.getBoundingClientRect();
    // Cursor-anchored zoom, preserving the artboard point under the cursor.
    const ax = typeof clientX === "number" ? clientX - rect.left - rect.width / 2 : 0;
    const ay = typeof clientY === "number" ? clientY - rect.top - rect.height / 2 : 0;
    const ratio = next / this.scale;
    this.x = ax - (ax - this.x) * ratio;
    this.y = ay - (ay - this.y) * ratio;
    this.scale = next;
    this.clamp();
    this.render();
  }

  fit() {
    if (this.busy()) return;
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.render();
  }

  render() {
    this.frame.style.transform = "translate3d(" + this.x + "px," + this.y + "px,0) scale(" + this.scale + ")";
    this.label.textContent = Math.round(this.scale * 100) + "%";
  }
}
