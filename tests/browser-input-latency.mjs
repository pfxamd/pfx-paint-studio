// Real Chromium pointer input -> Canvas 2D pixel-upload benchmark.
// Measurements end when putImageData returns, not when the display presents pixels.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const host = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const port = 9337;
const directory = await mkdtemp(path.join(tmpdir(), "pfx-latency-"));
await mkdir("test-artifacts", { recursive: true });
const browser = spawn(process.argv[2] || "google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--disable-extensions", "--disable-background-networking", "--no-first-run",
  "--remote-debugging-port=" + port,
  "--user-data-dir=" + path.join(directory, "profile"),
  "--window-size=1440,900", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

async function until(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try { const result = await fn(); if (result) return result; } catch { /* retry */ }
    await sleep(150);
  }
  throw Error("Timed out: " + label);
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(Error("CDP timeout: " + method));
        }, 30000);
        pending.set(key, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true
      });
      if (result.exceptionDetails) throw Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text
      );
      return result.result.value;
    },
    close() { socket.close(); }
  };
}

function installMeasurement() {
  return import("./src/engine.js").then(({ PaintingEngine }) => {
    const target = document.getElementById("paint-canvas");
    const measure = {
      samples: 0,
      pending: null,
      frames: [],
      addMs: [],
      endMs: [],
      brushInitMs: [],
      rasterStart: null,
      begin(brush, size) {
        this.pending = null;
        this.frames = [];
        document.querySelector('[data-brush="' + brush + '"]').click();
        const slider = document.getElementById("size");
        slider.value = String(size);
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        this.addMs = [];
        this.endMs = [];
        this.brushInitMs = [];
        this.samples = 0;
      }
    };
    window.__pfxLatency = measure;
    const brushCreate = PaintingEngine.prototype.createBrush;
    PaintingEngine.prototype.createBrush = function (...args) {
      const at = performance.now();
      const result = brushCreate.apply(this, args);
      if (this.canvas === target) measure.brushInitMs.push(performance.now() - at);
      return result;
    };
    const end = PaintingEngine.prototype.end;
    PaintingEngine.prototype.end = function (...args) {
      const at = performance.now();
      const result = end.apply(this, args);
      if (this.canvas === target) measure.endMs.push(performance.now() - at);
      return result;
    };
    const add = PaintingEngine.prototype.add;
    PaintingEngine.prototype.add = function (event, ...rest) {
      const start = performance.now();
      const previous = this.current?.points.length || 0;
      const result = add.call(this, event, ...rest);
      const finished = performance.now();
      if (this.canvas === target && this.current?.points.length > previous) {
        measure.addMs.push(finished - start);
        if (!measure.pending) measure.pending = {
          first: start, last: start, firstEvent: event.timeStamp,
          latestEvent: event.timeStamp, accepted: 0, eventDelay: []
        };
        measure.pending.last = start;
        measure.pending.latestEvent = event.timeStamp;
        measure.pending.accepted++;
        measure.samples++;
        const delay = start - event.timeStamp;
        if (Number.isFinite(delay) && delay >= 0 && delay < 1000) {
          measure.pending.eventDelay.push(delay);
        }
      }
      return result;
    };
    const render = PaintingEngine.prototype.renderDirty;
    PaintingEngine.prototype.renderDirty = function (...args) {
      if (this.canvas === target) measure.rasterStart = performance.now();
      try { return render.call(this, ...args); }
      finally { if (this.canvas === target) measure.rasterStart = null; }
    };
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      const start = performance.now();
      const result = put.call(this, ...args);
      const end = performance.now();
      if (this.canvas === target && measure.pending) {
        const pending = measure.pending;
        measure.pending = null;
        measure.frames.push({
          inputToUploadMs: end - pending.first,
          latestToUploadMs: end - pending.last,
          eventToUploadMs: end - pending.firstEvent,
          rasterMs: measure.rasterStart === null ? null : start - measure.rasterStart,
          pixelUploadMs: end - start,
          accepted: pending.accepted,
          dirtyPixels: args.length >= 7 ? args[5] * args[6] : target.width * target.height,
          eventDelayMs: pending.eventDelay.length
            ? Math.max(...pending.eventDelay) : null,
          at: end
        });
      }
      return result;
    };
    return true;
  });
}
function reportScenario(brush, size) {
  const m = window.__pfxLatency;
  const stats = values => {
    const a = values.filter(Number.isFinite).sort((x, y) => x - y);
    return {
      count: a.length, median: a[Math.floor((a.length - 1) * 0.5)],
      p95: a[Math.floor((a.length - 1) * 0.95)], max: a.at(-1)
    };
  };
  const frames = m.frames;
  return {
    brush, size, acceptedSamples: m.samples,
    uploadedFrames: frames.length,
    firstSampleToUploadMs: stats(frames.map(x => x.inputToUploadMs)),
    lastSampleToUploadMs: stats(frames.map(x => x.latestToUploadMs)),
    pixelUploadMs: stats(frames.map(x => x.pixelUploadMs)),
    addProcessingMs: stats(m.addMs),
    endProcessingMs: stats(m.endMs),
    brushInitMs: stats(m.brushInitMs),
    rasterMs: stats(frames.map(x => x.rasterMs)),
    eventToUploadMs: stats(frames.map(x => x.eventToUploadMs)),
    eventDelayMs: stats(frames.map(x => x.eventDelayMs)),
    acceptedPerFrame: stats(frames.map(x => x.accepted)),
    dirtyAreaPercent: stats(frames.map(x => x.dirtyPixels / (1200 * 800) * 100)),
    frameGapMs: stats(frames.slice(1).map((x, i) => x.at - frames[i].at)),
    frameGapsOver25ms: frames.slice(1).filter((x, i) => x.at - frames[i].at > 25).length
  };
}

let page;
try {
  const ws = await until(async () => {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list");
    return (await response.json()).find(x => x.type === "page")?.webSocketDebuggerUrl;
  }, "Chromium debugger");
  page = await connect(ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.navigate", { url: host });
  await until(async () => (await page.evaluate(
    "document.querySelector('#status')?.textContent || ''"
  )).includes("Ready to paint"), "paint runtime");

  await page.evaluate("(" + installMeasurement.toString() + ")()");
  const bounds = await page.evaluate('(() => { const r = document.querySelector("#paint-canvas").getBoundingClientRect(); return { x:r.left, y:r.top, width:r.width, height:r.height }; })()');
  const result = {
    browser: "Chromium (headless, software compositing)",
    unit: "milliseconds",
    endpoint: "CanvasRenderingContext2D.putImageData return (not physical display)",
    scenarios: []
  };
  const standard = [["pencil", 0], ["brush", 0], ["brush", 1]];
  const extended = [
    ["brush", 2], ["watercolor_expressive", 1], ["oil", 1],
    ["pastel", 1], ["marker_fat", 1], ["dry_brush", 1],
    ["textured_ink", 1]
  ];
  for (const [brush, size] of (process.env.PFX_LATENCY_STRESS === "1"
      ? standard.concat(extended) : standard)) {
    await page.evaluate("window.__pfxLatency.begin(" + JSON.stringify(brush) + "," + size + ")");
    const emit = async (type, x, y, buttons) => page.send("Input.dispatchMouseEvent", {
      type, x, y, button: type === "mouseMoved" ? "none" : "left",
      buttons, clickCount: type === "mouseMoved" ? 0 : 1
    });
    const x = i => bounds.x + bounds.width * (0.1 + 0.8 * i / 65);
    const y = i => bounds.y + bounds.height * (0.28 + 0.15 * Math.sin(i * 0.13));
    await emit("mouseMoved", x(0), y(0), 0);
    await emit("mousePressed", x(0), y(0), 1);
    for (let i = 1; i <= 65; i++) {
      await emit("mouseMoved", x(i), y(i), 1);
      await sleep(8);
    }
    await emit("mouseReleased", x(65), y(65), 0);
    await sleep(75); // Let pending drawing frames flush before reading measurements.
    const data = await page.evaluate("(" + reportScenario.toString() + ")(" +
      JSON.stringify(brush) + "," + size + ")");
    if (data.acceptedSamples < 30 || data.uploadedFrames < 12) {
      throw Error("Insufficient real pointer samples / rendered frames: " + JSON.stringify(data));
    }
    result.scenarios.push(data);
    console.log("INPUT_TO_CANVAS " + JSON.stringify(data));
  }
  await writeFile("test-artifacts/input-latency.json",
    JSON.stringify(result, null, 2) + "\n");
  console.log("INPUT_LATENCY_TEST_PASSED");
} catch (error) {
  console.error("INPUT_LATENCY_TEST_FAILED", error.stack || error);
  process.exitCode = 1;
} finally {
  page?.close();
  browser.kill("SIGTERM");
  await sleep(200);
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
