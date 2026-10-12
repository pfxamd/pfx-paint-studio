// End-to-end stylus input regression: dispatch real PointerEvents through
// the application's canvas listeners, not directly into PaintingEngine.add().
// Synthetic pen data exercises a scenario that physical CI hardware cannot send.
import { chromium, firefox } from "playwright";

const origin = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const chromePath = process.argv[2] || "/usr/bin/google-chrome";

async function exercise() {
  const canvas = document.querySelector("#paint-canvas");
  const { PaintingEngine } = await import("./src/engine.js");
  document.querySelector('[data-brush="marker_fat"]').click();
  const originalEnd = PaintingEngine.prototype.end;
  const originalAdd = PaintingEngine.prototype.add;
  const seen = [];
  let painting = null;
  PaintingEngine.prototype.add = function(event, ...args) {
    const before = this.current?.points.length || 0;
    const result = originalAdd.call(this, event, ...args);
    if (this.canvas === canvas) {
      seen.push({ inputTiltX: event.tiltX, inputTiltY: event.tiltY,
        pressure: event.pressure,
        samplesAdded: (this.current?.points.length || 0) - before });
    }
    return result;
  };
  PaintingEngine.prototype.end = function(...args) {
    const result = originalEnd.call(this, ...args);
    if (this.canvas === canvas) painting = this;
    return result;
  };

  const capture = canvas.setPointerCapture;
  // Native capture requires a hardware-originated active pointer. The
  // synthetic pen still travels through the real application listeners.
  canvas.setPointerCapture = () => {};
  const bounds = canvas.getBoundingClientRect();
  const x = bounds.x + bounds.width * 0.31;
  const y = bounds.y + bounds.height * 0.33;
  const pointerId = 71;
  const ev = (type, px, py, pressure, tiltX, tiltY) =>
    new PointerEvent(type, {
      bubbles: true, pointerId, pointerType: "pen", isPrimary: true,
      clientX: px, clientY: py, pressure, tiltX, tiltY,
      button: type === "pointerdown" ? 0 : -1,
      buttons: type === "pointerup" ? 0 : 1
    });
  const move = (coalesced, primary) => {
    Object.defineProperty(primary, "getCoalescedEvents",
      { value: () => [coalesced] });
    canvas.dispatchEvent(primary);
  };
  try {
    canvas.dispatchEvent(ev("pointerdown", x, y, 0.55, 0, 0));
    // Native coalesced point and final parent have the same position and
    // pressure, but *both tilt axes* change. Both must reach the engine.
    move(
      ev("pointermove", x + 40, y + 10, 0.55, 10, -5),
      ev("pointermove", x + 40, y + 10, 0.55, 45, -30)
    );
    // Exact parent duplicate: no artificial extra sample.
    move(
      ev("pointermove", x + 60, y + 15, 0.55, 45, -30),
      ev("pointermove", x + 60, y + 15, 0.55, 45, -30)
    );
    // A stationary pen still paints over time. The coalesced event is older
    // by 16 ms; the final endpoint must be delivered even when all other
    // properties match.
    await new Promise(resolve => setTimeout(resolve, 25));
    const final = ev("pointermove", x + 60, y + 15, 0.55, 45, -30);
    const old = ev("pointermove", x + 60, y + 15, 0.55, 45, -30);
    Object.defineProperty(old, "timeStamp", { value: final.timeStamp - 16 });
    move(old, final);
    move(
      ev("pointermove", x + 80, y + 20, 0.55, 45, -30),
      ev("pointermove", x + 80, y + 20, 0.82, 45, -30)
    );
    canvas.dispatchEvent(ev("pointerup", x + 85, y + 22, 0, 45, -30));
    if (!painting || painting.history.length !== 1)
      throw Error("Pen stroke did not finish through application input");
    painting.renderNow();
    const hash = async c => {
      const pixels = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", pixels));
      return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    };
    const initial = await hash(canvas);
    const points = painting.history[0].points;
    const matches = (a, b) => Math.abs(a - b) < 0.002;
    const coalescedTilt = points.some(p =>
      matches(p.xtilt, Math.sin(10 * Math.PI / 180)) &&
      matches(p.ytilt, Math.sin(-5 * Math.PI / 180)));
    const finalTilt = points.some(p =>
      matches(p.xtilt, Math.sin(45 * Math.PI / 180)) &&
      matches(p.ytilt, Math.sin(-30 * Math.PI / 180)));
    const finalCall = seen.find(s =>
      s.inputTiltX === 45 && s.inputTiltY === -30 &&
      Math.abs(s.pressure - 0.55) < 0.005);
    const identicalExtra = seen.filter(s =>
      s.inputTiltX === 45 && s.inputTiltY === -30 &&
      Math.abs(s.pressure - 0.55) < 0.005 &&
      s.samplesAdded === 0).length;
    const dwellPreserved = points.some((p, i) => i &&
      p.dt >= 0.012 && p.dt <= 0.15 &&
      matches(p.x, points[i - 1].x) && matches(p.y, points[i - 1].y));
    const retainedPressure = points.some(p => Math.abs(p.pressure - 0.82) < 0.002);
    const zeroLift = points.at(-1).pressure === 0;
    painting.undo();
    painting.redo();
    painting.renderNow();
    const undoRedoExact = await hash(canvas) === initial;
    const saved = painting.snapshot();
    const other = document.createElement("canvas");
    other.width = canvas.width; other.height = canvas.height;
    const clone = new PaintingEngine(other, painting.wasm, painting.brushSources, () => {});
    clone.restoreArtwork(saved);
    const replayExact = await hash(other) === initial;
    // This preset maps tilt to dab aspect, angle and radius. Confirm that
    // retaining tilt changes the actual artwork, not just stroke metadata.
    const noTiltHistory = structuredClone(saved);
    for (const stroke of noTiltHistory.history) {
      for (const p of stroke.points) { p.xtilt = 0; p.ytilt = 0; }
    }
    clone.restoreArtwork(noTiltHistory);
    const tiltAffectsPixels = await hash(other) !== initial;

    const result = { coalescedTilt, finalTilt, finalCall: !!finalCall,
      tiltAffectsPixels,
      identicalExtra, dwellPreserved, retainedPressure, zeroLift,
      undoRedoExact, replayExact, points: points.length,
      forwardedPenSamples: seen.length };
    clone.releaseCheckpoints();
    clone.active.free();
    clone.surface.free();
    return result;
  } finally {
    canvas.setPointerCapture = capture;
    PaintingEngine.prototype.end = originalEnd;
    PaintingEngine.prototype.add = originalAdd;
  }
}

for (const [name, type] of [["Chromium", chromium], ["Firefox", firefox]]) {
  const options = name === "Chromium"
    ? { headless: true, executablePath: chromePath,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }
    : { headless: true };
  const browser = await type.launch(options);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent?.includes("Ready to paint"),
      { timeout: 45000 }
    );
    const result = await page.evaluate(exercise);
    const keys = ["coalescedTilt", "finalTilt", "finalCall", "tiltAffectsPixels", "dwellPreserved",
      "retainedPressure", "zeroLift", "undoRedoExact", "replayExact"];
    const failed = keys.filter(key => !result[key]);
    if (failed.length || result.points < 15)
      throw Error(name + " incomplete pen dynamics: " +
        JSON.stringify({ failed, ...result }));
    // Identical coalesced positions are accepted or dropped depending on
    // the native event timestamp and dwell, which legitimately differs by
    // browser. Verify the application forwards the right nine input events.
    if (result.forwardedPenSamples !== 9)
      throw Error(name + " coalesced endpoint dispatch mismatch: " +
        JSON.stringify(result));
    console.log("PEN_ARTISTIC_INPUT_PASSED " + name + " " + JSON.stringify(result));
    await page.close();
  } finally {
    await browser.close();
  }
}
console.log("PEN_ARTISTIC_REGRESSION_PASSED");
