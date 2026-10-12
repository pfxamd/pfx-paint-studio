// Regression: pixel tiles alone are NOT enough to resume a random-textured
// brush. The persisted checkpoint must also restore the PRNG's exact state.
// Uses real compiled Hokusai WASM in Chromium and Firefox, not mocked brushes.
import { chromium, firefox } from "playwright";

const ORIGIN = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const chromePath = process.argv[2] || "/usr/bin/google-chrome";

async function exercise() {
  const { PaintingEngine } = await import("./src/engine.js");
  const canvas = () => {
    const el = document.createElement("canvas");
    el.width = 360; el.height = 220; return el;
  };
  const base = await PaintingEngine.create(canvas(), () => {});
  const clone = () => new PaintingEngine(canvas(), base.wasm, base.brushSources, () => {});
  const rect = { left: 0, top: 0, width: 360, height: 220 };
  const event = (x, y, pressure, t) => ({
    clientX: x, clientY: y, pointerType: "pen",
    pressure, tiltX: 7, tiltY: -11, timeStamp: t
  });
  const draw = (e, index, preset) => {
    e.configure({ brushId: preset, color: index % 2 ? "#d93968" : "#275ba9",
      size: -0.3, eraser: false });
    const x = 18 + index * 17, y = 24 + index * 11;
    const t = 3000 + index * 750;
    e.begin(event(x, y, 0.48, t), rect);
    for (let i = 1; i <= 12; i++) {
      e.add(event(x + i * 4.7, y + 5 * Math.sin(i * 0.5), 
        0.3 + 0.5 * i / 12, t + i * 12), rect);
    }
    e.end();
  };
  const hash = async e => {
    e.renderNow();
    const bytes = e.context.getImageData(0, 0, 360, 220).data;
    const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...dig].map(x => x.toString(16).padStart(2, "0")).join("");
  };
  const done = e => {
    e.releaseCheckpoints(); e.active.free(); e.surface.free();
  };
  const results = {};
  const all = [base];
  try {
    for (const preset of ["dry_brush", "textured_ink", "pastel", "watercolor_expressive"]) {
      const original = clone();
      all.push(original);
      // Checkpoints at 4, 8; tail at 9 and 10 must reproduce
      // the same random stream as live painting.
      for (let i = 0; i < 10; i++) draw(original, i, preset);
      const expected = await hash(original);
      const saved = await original.snapshotForAutosave();
      if (saved.tileCache?.checkpoints?.length < 2)
        throw Error(preset + ": missing compressed checkpoints");

      const restored = clone();
      all.push(restored);
      const used = await restored.restoreSavedArtwork(structuredClone(saved));
      const restoredDigest = await hash(restored);
      if (!used || restoredDigest !== expected)
        throw Error(preset + ": cached texture does not match original pixels");

      const full = clone();
      all.push(full);
      full.restoreArtwork(structuredClone(saved));
      if (await hash(full) !== expected)
        throw Error(preset + ": full stroke replay changed texture");

      // Appending MUST match: the next dab's Random input depends on
      // the full historical PRNG stream, not just the saved pixels.
      for (const e of [original, restored, full]) draw(e, 10, preset);
      const extended = await hash(original);
      if (await hash(restored) !== extended || await hash(full) !== extended)
        throw Error(preset + ": future texture diverged after reopening");

      original.undo();
      original.redo();
      restored.undo();
      restored.redo();
      full.undo();
      full.redo();
      const afterOriginal = await hash(original);
      const afterCached = await hash(restored);
      const afterFull = await hash(full);
      if (afterCached !== extended || afterOriginal !== extended || afterFull !== extended)
        throw Error(preset + ": redo differs (live " + (afterOriginal===extended) +
          ", compressed " + (afterCached===extended) +
          ", replay " + (afterFull===extended) +
          ", checkpoints " + restored.checkpoints.map(p=>p.count).join(",") + ")");

      // Old cache payloads lack RNG bytes. Reject their optimization
      // and replay the authoritative strokes rather than using wrong state.
      const legacy = structuredClone(saved);
      for (const entry of legacy.tileCache.checkpoints) {
        delete entry.rngState; delete entry.rngDigest;
      }
      const older = clone();
      all.push(older);
      const usedLegacy = await older.restoreSavedArtwork(legacy);
      if (usedLegacy || await hash(older) !== expected)
        throw Error(preset + ": old tile cache was not safely replayed");
      draw(older, 10, preset);
      if (await hash(older) !== extended)
        throw Error(preset + ": old cache fallback changed future texture");

      // A modified random-state byte must invalidate the checkpoint
      // even if its pixel tiles are perfectly intact.
      const damaged = structuredClone(saved);
      for (const entry of damaged.tileCache.checkpoints) entry.rngState[7] ^= 1;
      const recovery = clone();
      all.push(recovery);
      const usedDamaged = await recovery.restoreSavedArtwork(damaged);
      if (usedDamaged || await hash(recovery) !== expected)
        throw Error(preset + ": RNG tampering was not rejected");
      draw(recovery, 10, preset);
      if (await hash(recovery) !== extended)
        throw Error(preset + ": damaged RNG fallback changed future texture");

      results[preset] = { checkpoints: saved.tileCache.checkpoints.length,
        rngBytes: saved.tileCache.checkpoints[0].rngState.byteLength,
        cachedPixelsIdentical: true, nextStrokeIdentical: true,
        undoRedoIdentical: true, legacyFallback: true, corruptionFallback: true };
    }
    return results;
  } finally {
    for (const e of all) done(e);
  }
}

for (const [name, type] of [["Chromium", chromium], ["Firefox", firefox]]) {
  const browser = await type.launch(name === "Chromium"
    ? { executablePath: chromePath, headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }
    : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(120000);
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("Ready to paint"),
      { timeout: 60000 });
    const result = await page.evaluate(exercise);
    console.log("TEXTURE_CHECKPOINT_PASSED " + name + " " + JSON.stringify(result));
  } finally { await browser.close(); }
}
console.log("TEXTURE_CHECKPOINT_REGRESSION_PASSED");
