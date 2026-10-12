// Extended 2000-stroke stress test. Real Playwright Chromium and Firefox;
// an isolated canvas/real WASM engine, without modifying the application UI.
// Run only on explicit CI dispatch or stress-test pull requests.
import { chromium, firefox } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const URL = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const CHROME = process.argv[2] || "/usr/bin/google-chrome";
const TOTAL = 2000;
const MARKS = [500, 1000, 1500, 2000];
const output = { workload: "2000 strokes, 8 rotating heavy brush presets, WASM",
  artwork: [1200, 800], browsers: {}, timeUnit: "ms",
  limits: "Headless software rendering; not physical stylus or screen-presentation latency" };
await mkdir("test-artifacts", { recursive: true });

const check = (ok, why) => { if (!ok) throw Error(why); };
const percentiles = values => {
  const v = values.slice().sort((a, b) => a - b);
  return {
    count: v.length, median: v[Math.floor((v.length - 1) / 2)],
    p95: v[Math.floor((v.length - 1) * 0.95)], max: v.at(-1)
  };
};

async function setup() {
  const { PaintingEngine } = await import("./src/engine.js");
  const { createAutosave, openArtworkDatabase } = await import("./src/autosave.js");
  const canvas = document.createElement("canvas");
  canvas.width = 1200; canvas.height = 800;
  const engine = await PaintingEngine.create(canvas, () => {});
  const db = await openArtworkDatabase();
  const status = [];
  const autosave = createAutosave(db, value => status.push(value));
  window.__pfxHeavy = {
    engine, canvas, db, autosave, status,
    next: 0, tick: 1000,
    rect: { left: 0, top: 0, width: 1200, height: 800 }
  };
  return { ready: !!engine.active && !!db };
}

async function drawBatch(end) {
  const s = window.__pfxHeavy, e = s.engine;
  const brushes = [
    ["watercolor_expressive", 0.5], ["watercolor_glazing", 0.5],
    ["oil", 0.5], ["acrylic", 0.4], ["pastel", 0.5],
    ["dry_brush", 0.5], ["textured_ink", 0.5], ["brush", 1]
  ];
  const durations = [], rafGaps = [], perBrush = {};
  let previousFrame = performance.now();
  for (let n = s.next; n < end; n++) {
    const [brushId, size] = brushes[Math.floor(n / 20) % brushes.length];
    if (n % 20 === 0) e.configure({ brushId, size, eraser: false });
    const x = 60 + n * 59 % 1020;
    const y = 60 + n * 43 % 660;
    const pen = Math.floor(n / 20) % 3 === 0;
    const event = (x0, y0, i) => ({
      clientX: x0, clientY: y0, timeStamp: s.tick,
      pointerType: pen ? "pen" : "mouse",
      pressure: pen ? 0.35 + 0.55 * Math.sin((i + 1) / 14 * Math.PI) : 1,
      tiltX: pen ? 25 * Math.sin(i * 0.2) : 0,
      tiltY: pen ? -15 * Math.cos(i * 0.3) : 0
    });
    s.tick += 15;
    const begin = performance.now();
    e.begin(event(x, y, 0), s.rect);
    for (let i = 1; i <= 12; i++) {
      s.tick += 10;
      e.add(event(x + 2.4 * i, y + 11 * Math.sin(i * 0.47 + n * 0.13), i), s.rect);
    }
    e.end();
    const elapsed = performance.now() - begin;
    durations.push(elapsed);
    (perBrush[brushId] ||= []).push(elapsed);
    if (n % 8 === 7) {
      const frame = await new Promise(resolve => requestAnimationFrame(resolve));
      rafGaps.push(frame - previousFrame);
      previousFrame = frame;
    }
  }
  s.next = end;
  await new Promise(resolve => requestAnimationFrame(resolve));
  return {
    strokes: e.history.length,
    points: e.history.reduce((total, stroke) => total + stroke.points.length, 0),
    checkpoints: e.checkpoints.length,
    wasmBufferBytes: e.wasm.memory.buffer.byteLength,
    jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
    strokeTimes: durations,
    perBrush, frameGaps: rafGaps,
    numberOfFramesOver25ms: rafGaps.filter(ms => ms > 25).length,
    numberOfFramesOver50ms: rafGaps.filter(ms => ms > 50).length
  };
}

async function verifyCheckpoint() {
  const s = window.__pfxHeavy, e = s.engine;
  const hash = async canvas => {
    const bytes = canvas.getContext("2d").getImageData(0, 0, 1200, 800).data;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), value =>
      value.toString(16).padStart(2, "0")).join("");
  };
  e.renderNow();
  const baseline = await hash(s.canvas);
  const undo = [], redo = [];
  for (let i = 0; i < 8; i++) {
    const before = performance.now();
    e.undo();
    undo.push(performance.now() - before);
  }
  for (let i = 0; i < 8; i++) {
    const before = performance.now();
    e.redo();
    redo.push(performance.now() - before);
  }
  e.renderNow();
  const checksumUndoRedo = await hash(s.canvas);
  const snapshot = e.snapshot();
  const copy = document.createElement("canvas");
  copy.width = 1200; copy.height = 800;
  const replica = new e.constructor(copy, e.wasm, e.brushSources, () => {});
  const start = performance.now();
  replica.restoreArtwork(snapshot);
  const restoreMs = performance.now() - start;
  const checksumReplay = await hash(copy);
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
  replica.releaseCheckpoints();
  replica.active.free();
  replica.surface.free();

  const started = performance.now();
  s.autosave.save(() => e.snapshot());
  let saved;
  const { loadArtwork } = await import("./src/autosave.js");
  for (let tries = 0; tries < 150; tries++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    saved = await loadArtwork(s.db, 1200, 800);
    if (saved?.history.length === s.next && s.status.at(-1) === "Saved locally") break;
  }
  const points = saved?.history.reduce((total, stroke) =>
    total + stroke.points.length, 0);
  return {
    count: s.next, originalDigest: baseline,
    equalUndoRedo: baseline === checksumUndoRedo,
    equalReplay: baseline === checksumReplay,
    persisted: saved?.history.length === s.next && s.status.at(-1) === "Saved locally",
    points, snapshotPoints: snapshot.history.reduce((total, stroke) =>
      total + stroke.points.length, 0),
    undoMs: undo, redoMs: redo, restoreMs,
    saveElapsedMs: performance.now() - started,
    saveFailures: s.status.filter(status => status === "Save failed").length
  };
}

async function verifyAfterReload() {
  const { PaintingEngine } = await import("./src/engine.js");
  const { openArtworkDatabase, loadArtwork } = await import("./src/autosave.js");
  const db = await openArtworkDatabase();
  const saved = await loadArtwork(db, 1200, 800);
  const canvas = document.createElement("canvas");
  canvas.width = 1200; canvas.height = 800;
  const engine = await PaintingEngine.create(canvas, () => {});
  const start = performance.now();
  engine.restoreArtwork(saved);
  const elapsed = performance.now() - start;
  const bytes = canvas.getContext("2d").getImageData(0, 0, 1200, 800).data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const checksum = Array.from(new Uint8Array(digest), value =>
    value.toString(16).padStart(2, "0")).join("");
  engine.releaseCheckpoints();
  engine.active.free();
  engine.surface.free();
  db.close();
  return {
    savedStrokes: saved.history.length,
    savedPoints: saved.history.reduce((sum, s) => sum + s.points.length, 0),
    digest: checksum, replayMs: elapsed
  };
}

async function runBrowser(name, browserType) {
  const opts = name === "Chromium"
    ? { executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu",
        "--disable-dev-shm-usage", "--disable-background-networking"], headless: true }
    : { headless: true };
  const browser = await browserType.launch(opts);
  const entry = { milestones: [], integrity: [], status: "running" };
  output.browsers[name] = entry;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent.includes("Ready to paint"),
      { timeout: 90000 }
    );
    check((await page.evaluate(setup)).ready, name + ": fixture not initialized");
    let lastDigest = null, lastPoints = 0;
    for (const mark of MARKS) {
      if (name === "Chromium") {
        try {
          const session = await context.newCDPSession(page);
          await session.send("HeapProfiler.collectGarbage");
          await session.detach();
        } catch { /* Chromium-only optional GC */ }
      }
      const batch = await page.evaluate(drawBatch, mark);
      check(batch.strokes === mark && batch.points > mark * 12,
        name + ": truncated strokes or points at " + mark);
      check(batch.checkpoints <= 3,
        name + ": checkpoint cap exceeded");
      const entryAt = {
        strokes: mark, points: batch.points, checkpoints: batch.checkpoints,
        wasmBufferMiB: +(batch.wasmBufferBytes / 1048576).toFixed(1),
        jsHeapMiB: batch.jsHeapBytes === null ? null :
          +(batch.jsHeapBytes / 1048576).toFixed(1),
        strokeMs: percentiles(batch.strokeTimes),
        perBrush: Object.fromEntries(Object.entries(batch.perBrush)
          .map(([brush, times]) => [brush, percentiles(times)])),
        frameGapMs: percentiles(batch.frameGaps),
        frameGapsOver25ms: batch.numberOfFramesOver25ms,
        frameGapsOver50ms: batch.numberOfFramesOver50ms
      };
      entry.milestones.push(entryAt);
      console.log("HEAVY_MILESTONE " + name + " " + JSON.stringify(entryAt));
      if (mark === 1000 || mark === TOTAL) {
        const checkResult = await page.evaluate(verifyCheckpoint);
        check(checkResult.equalUndoRedo && checkResult.equalReplay,
          name + ": pixel checksum changed at " + mark);
        check(checkResult.persisted && checkResult.points === checkResult.snapshotPoints &&
          checkResult.saveFailures === 0, name + ": local autosave lost data at " + mark);
        entry.integrity.push({
          strokes: mark, pixelsIdentical: true, persisted: true,
          undoMs: percentiles(checkResult.undoMs),
          redoMs: percentiles(checkResult.redoMs),
          restoreMs: checkResult.restoreMs,
          saveElapsedMs: checkResult.saveElapsedMs,
          points: checkResult.points
        });
        lastDigest = checkResult.originalDigest;
        lastPoints = checkResult.points;
        console.log("HEAVY_INTEGRITY " + name + " " +
          JSON.stringify(entry.integrity.at(-1)));
      }
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent.includes("restored"),
      { timeout: 90000 }
    );
    const after = await page.evaluate(verifyAfterReload);
    check(after.savedStrokes === TOTAL && after.savedPoints === lastPoints &&
      after.digest === lastDigest, name + ": persisted artwork differs after reload");
    entry.reload = { strokes: after.savedStrokes, points: after.savedPoints,
      checksumIdentical: true, replayMs: after.replayMs };
    check(errors.length === 0, name + ": page errors: " + errors.join("; "));
    entry.uncaughtErrors = 0;
    entry.status = "passed";
    console.log("HEAVY_BROWSER_PASSED " + name + " " + JSON.stringify(entry.reload));
    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  await runBrowser("Chromium", chromium);
  await runBrowser("Firefox", firefox);
  console.log("HEAVY_ENDURANCE_TEST_PASSED");
} catch (error) {
  output.failure = error.stack || String(error);
  console.error("HEAVY_ENDURANCE_TEST_FAILED", output.failure);
  process.exitCode = 1;
} finally {
  await writeFile("test-artifacts/heavy-endurance.json",
    JSON.stringify(output, null, 2) + "\n");
}
