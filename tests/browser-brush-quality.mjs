// Artistic brush quality regression: exercised through the real bundled
// WebAssembly painting engine in Chromium and Firefox. No pixel baselines
// hard-coded to one renderer: verify pigment pickup, dry texture and exact replay.
import { chromium, firefox } from "playwright";

const URL = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const chromePath = process.argv[2] || "/usr/bin/google-chrome";

async function inspect() {
  const { PaintingEngine } = await import("./src/engine.js");
  const master = document.createElement("canvas");
  master.width = 360;
  master.height = 200;
  const seed = await PaintingEngine.create(master, () => {});
  const brushSources = seed.brushSources;
  const wasm = seed.wasm;
  const rect = { left: 0, top: 0, width: 360, height: 200 };

  const event = (x, y, time, pressure = 0.8) => ({
    clientX: x, clientY: y, pointerType: "pen", pressure,
    tiltX: 0, tiltY: 0, timeStamp: time
  });
  const stroke = (engine, brushId, color, y, pressure = 0.8) => {
    engine.configure({ brushId, color, size: 0.25, eraser: false });
    engine.begin(event(35, y, 1100, pressure), rect);
    for (let i = 1; i <= 44; i++) {
      const x = 35 + i * 6.3;
      engine.add(event(x, y + Math.sin(i * 0.32) * 3, 1100 + i * 10, pressure), rect);
    }
    engine.end();
    engine.renderNow();
  };
  const pixels = engine => {
    engine.renderNow();
    return engine.context.getImageData(0, 0, 360, 200).data;
  };
  const digest = async engine => {
    const hash = await crypto.subtle.digest("SHA-256", pixels(engine));
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
  };
  const engine = (sources = brushSources) => {
    const canvas = document.createElement("canvas");
    canvas.width = 360; canvas.height = 200;
    return new PaintingEngine(canvas, wasm, sources, () => {});
  };
  const free = engine => {
    engine.releaseCheckpoints(); engine.active.free(); engine.surface.free();
  };
  const report = { mixer: {}, dryTexture: {}, replay: {} };
  const engines = [seed];
  try {
    for (const id of ["oil", "watercolor_glazing", "watercolor_expressive"]) {
      const actual = engine(), noSmudgeSources = new Map(brushSources);
      engines.push(actual);
      const raw = JSON.parse(noSmudgeSources.get(id));
      raw.settings.smudge.base_value = 0;
      raw.settings.smudge.inputs = {};
      noSmudgeSources.set(id, JSON.stringify(raw));
      const control = engine(noSmudgeSources);
      engines.push(control);
      // Place an opaque warm paint underneath the same cool top brush.
      for (const target of [actual, control]) {
        stroke(target, "brush", "#e74d20", 103, 1);
        stroke(target, id, "#215edc", 103, 0.72);
      }
      const before = await digest(actual);
      const without = await digest(control);
      report.mixer[id] = { distinctFromNoSmudge: before !== without,
        strokes: actual.history.length };
      if (before === without)
        throw Error(id + " did not pick up canvas pigment with active smudge");
      actual.undo();
      actual.redo();
      report.replay[id] = { undoRedoIdentical: await digest(actual) === before };
      const clone = engine();
      engines.push(clone);
      clone.restoreArtwork(actual.snapshot());
      report.replay[id].reconstructionIdentical = await digest(clone) === before;
      if (!report.replay[id].undoRedoIdentical || !report.replay[id].reconstructionIdentical)
        throw Error(id + " color blending is not deterministic on replay");
    }

    for (const id of ["dry_brush", "textured_ink", "pastel"]) {
      const painted = engine();
      engines.push(painted);
      stroke(painted, id, "#2a3244", 95, 0.77);
      const pix = pixels(painted);
      const colors = new Set();
      let marks = 0;
      for (let y = 50; y < 145; y += 2) {
        for (let x = 32; x < 320; x += 2) {
          const at = (y * 360 + x) * 4;
          const r = pix[at], g = pix[at + 1], b = pix[at + 2];
          if (r < 245 || g < 245 || b < 245) {
            marks++;
            colors.add((r << 16) | (g << 8) | b);
          }
        }
      }
      report.dryTexture[id] = { nonWhiteSamples: marks, distinctInkColors: colors.size };
      if (marks < 40 || colors.size < 12)
        throw Error(id + " appears visually flat or left insufficient textured ink");
      const before = await digest(painted);
      painted.undo(); painted.redo();
      if (await digest(painted) !== before)
        throw Error(id + " texture changed after undo/redo");
    }
    return report;
  } finally {
    for (const e of engines) free(e);
  }
}

for (const [name, type] of [["Chromium", chromium], ["Firefox", firefox]]) {
  const browser = await type.launch(name === "Chromium"
    ? { headless: true, executablePath: chromePath,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }
    : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Ready to paint"),
      { timeout: 45000 });
    const result = await page.evaluate(inspect);
    console.log("BRUSH_QUALITY_PASSED " + name + " " + JSON.stringify(result));
    await page.close();
  } finally {
    await browser.close();
  }
}
console.log("ARTISTIC_BRUSH_REGRESSION_PASSED");
