// Real Firefox on Linux, driven through Playwright's Firefox protocol.
// The app has no Playwright dependency; this script runs only in CI.
import { firefox } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

const URL = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const DIR = "test-artifacts";
await mkdir(DIR, { recursive: true });
const report = { browser: "Firefox", runtime: "Linux", checks: [], warnings: [], metrics: {} };
const assert = (value, name) => {
  if (!value) throw new Error(name);
  report.checks.push(name);
  console.log("FIREFOX PASS", name);
};
const waitFor = async (fn, message, ms = 20000) => {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw Error("Firefox timed out: " + message);
};
const ink = async (page) => page.evaluate(() => {
  const c = document.querySelector("#paint-canvas");
  const pixels = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let count = 0, darkness = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const d = 765 - pixels[i] - pixels[i + 1] - pixels[i + 2];
    if (d > 50) count++;
    darkness += Math.max(0, d);
  }
  return { count, darkness };
});
const artBounds = async page => {
  const b = await page.locator("#paint-canvas").boundingBox();
  if (!b || b.width < 100 || b.height < 70) throw Error("Firefox artboard not displayed");
  return b;
};
const paintLine = async (page, sx, sy, ex, ey, steps = 48) => {
  const b = await artBounds(page);
  const x = t => b.x + b.width * (sx + (ex - sx) * t);
  const y = t => b.y + b.height * (sy + (ey - sy) * t);
  await page.mouse.move(x(0), y(0));
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= steps; i++) await page.mouse.move(x(i / steps), y(i / steps));
  await page.mouse.up({ button: "left" });
};
const savedArtwork = async page => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("pfx-paint-studio", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("artwork", "readonly");
      const request = tx.objectStore("artwork").get("current");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
});
let browser, context, page;
try {
  browser = await firefox.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    reducedMotion: "reduce"
  });
  page = await context.newPage();
  page.on("pageerror", error => report.warnings.push("Page error: " + error.message));
  page.on("console", message => {
    if (message.type() === "error") report.warnings.push("Console error: " + message.text());
  });

  const response = await page.goto(URL, { waitUntil: "domcontentloaded" });
  assert(response?.ok(), "Art studio served in Firefox");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Ready to paint"), { timeout: 30000 });
  assert(await page.locator(".brush-card").count() === 12, "All local brush presets loaded");
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-brush="charcoal"] .brush-preview');
    return c && c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((x, i) => i % 4 === 3 && x > 0);
  }, { timeout: 30000 });
  assert((await ink(page)).count === 0, "White pixel-perfect initial artboard");
  const capabilities = await page.evaluate(() => ({
    wasm: typeof WebAssembly === "object",
    coalesced: typeof PointerEvent.prototype.getCoalescedEvents === "function",
    indexedDB: typeof indexedDB !== "undefined",
    ua: navigator.userAgent
  }));
  report.metrics.capabilities = capabilities;
  assert(capabilities.wasm && capabilities.indexedDB, "Firefox WASM and IndexedDB available");

  const box = await artBounds(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  assert(await page.locator(".artboard-stage").evaluate(el => el.classList.contains("cursor-active")), "Custom mouse cursor active on artboard");
  assert(await page.locator("#paint-pointer").getAttribute("data-mode") === "brush", "Accurate brush cursor mode");

  await page.mouse.wheel(0, -280);
  await waitFor(async () => (await page.locator("#zoom-label").textContent()) !== "100%", "Wheel zoom");
  const zoomed = await page.locator("#zoom-label").textContent();
  assert(Number.parseInt(zoomed) > 100, "Firefox wheel scales canvas without scrolling page");

  // Native middle-button mouse dragging exercises the real pointer-capture route.
  const startTransform = await page.locator("#artboard-frame").evaluate(el => el.style.transform);
  const zoomBox = await artBounds(page);
  const mx = zoomBox.x + zoomBox.width * 0.5, my = zoomBox.y + zoomBox.height * 0.5;
  await page.mouse.move(mx, my);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(mx + 42, my + 26);
  await page.mouse.up({ button: "middle" });
  assert((await page.locator("#artboard-frame").evaluate(el => el.style.transform)) !== startTransform, "Middle-button pan moves workbench");
  assert((await ink(page)).count === 0, "Panning never creates a brush stroke");
  await page.locator("#zoom-fit").click();
  assert((await page.locator("#zoom-label").textContent()) === "100%", "Fit resets workbench");

  await page.locator('[data-brush="calligraphy"]').click();
  await page.evaluate(async () => {
    const { PaintingEngine } = await import("./src/engine.js");
    const original = PaintingEngine.prototype.add;
    window.__firefoxPaintTimes = [];
    PaintingEngine.prototype.add = function (...args) {
      const t = performance.now();
      try { return original.apply(this, args); }
      finally { window.__firefoxPaintTimes.push(performance.now() - t); }
    };
  });

  await paintLine(page, 0.24, 0.42, 0.74, 0.57, 60);
  await waitFor(async () => (await ink(page)).count > 60, "Real pigment appears");
  const drawing = await ink(page);
  assert(drawing.count > 60, "Firefox draws real Hokusai pixels during mouse drag");
  const samples = await page.evaluate(() => window.__firefoxPaintTimes);
  assert(samples.length > 10, "Firefox mouse stroke processes multiple pointer samples");
  const ordered = samples.slice().sort((a,b) => a-b);
  report.metrics.pointerProcessingMs = {
    count: samples.length,
    median: ordered[Math.floor((ordered.length - 1) * 0.5)],
    p95: ordered[Math.floor((ordered.length - 1) * 0.95)],
    max: ordered[ordered.length - 1]
  };
  await waitFor(async () => (await savedArtwork(page))?.history.length === 1, "Completed stroke autosaved in Firefox");
  const saved = await savedArtwork(page);
  assert(saved.history[0].points.length > 10, "Saved brush path retains detailed points");
  await page.screenshot({ path: path.join(DIR, "firefox-painted.png"), fullPage: true });

  await page.locator("#undo").click();
  await waitFor(async () => (await ink(page)).count === 0, "Undo clears artboard");
  await page.locator("#redo").click();
  await waitFor(async () => (await ink(page)).count > 60, "Redo restores artwork");
  assert((await ink(page)).count > 60, "Undo and redo preserve visible artwork");

  await page.locator("#tool-eraser").click();
  const canvasMid = await artBounds(page);
  await page.mouse.move(canvasMid.x + canvasMid.width * 0.4, canvasMid.y + canvasMid.height * 0.4);
  assert((await page.locator("#paint-pointer").getAttribute("data-mode")) === "eraser", "Eraser cursor switches correctly");
  await paintLine(page, 0.24, 0.42, 0.74, 0.57, 60);
  await waitFor(async () => (await ink(page)).darkness < drawing.darkness, "Eraser removes pigment");
  assert((await ink(page)).darkness < drawing.darkness, "Real Firefox erasing works");

  await page.locator("#tool-picker").click();
  const pick = await artBounds(page);
  await page.mouse.click(pick.x + pick.width * 0.9, pick.y + pick.height * 0.14);
  assert((await page.locator("#tool-brush").getAttribute("aria-pressed")) === "true", "Eyedropper samples and returns to painting");

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#save").click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  assert(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "Firefox downloads valid PNG");
  assert(bytes.readUInt32BE(16) === 1200 && bytes.readUInt32BE(20) === 800, "PNG retains full artwork resolution");

  const beforeReload = await ink(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("restored"), { timeout: 30000 });
  const recovered = await ink(page);
  assert(recovered.count === beforeReload.count && recovered.darkness === beforeReload.darkness, "Local artwork restores exactly in Firefox");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const mobile = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    pointer: document.querySelector(".artboard-stage").classList.contains("cursor-active")
  }));
  assert(mobile.width <= mobile.viewportWidth + 2 && mobile.height <= mobile.viewportHeight + 2, "Firefox mobile viewport fits without document scrolling");
  assert(!mobile.pointer, "Desktop cursor is disabled at mobile width");
  await page.screenshot({ path: path.join(DIR, "firefox-mobile.png"), fullPage: true });

  assert(!report.warnings.some(msg => msg.startsWith("Page error:")), "No uncaught Firefox page exceptions");
  console.log("FIREFOX_REPORT " + JSON.stringify(report));
  console.log("ALL FIREFOX INTERACTION TESTS PASSED");
} catch (error) {
  console.error("FIREFOX_FAILED " + (error.stack || error));
  process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(DIR, "firefox-failure.png"), fullPage: true }).catch(() => {});
} finally {
  await writeFile(path.join(DIR, "firefox-results.json"), JSON.stringify(report, null, 2) + "\n");
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
