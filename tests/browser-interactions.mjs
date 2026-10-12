import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const URL = process.env.PFX_TEST_URL || "http://127.0.0.1:8732/";
const PORT = 9334;
const ROOT = await mkdtemp(path.join(tmpdir(), "pfx-browser-"));
const DOWNLOADS = path.join(ROOT, "downloads");
await mkdir(DOWNLOADS, { recursive: true });
await mkdir("test-artifacts", { recursive: true });
const chrome = spawn(process.argv[2] || "google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  "--no-first-run", "--disable-background-networking", "--disable-extensions",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + path.join(ROOT, "profile"),
  "--window-size=1440,900", "--force-device-scale-factor=1", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeLog = "";
chrome.stderr.on("data", b => { chromeLog = (chromeLog + b.toString()).slice(-5000); });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map(); this.errors = [];
    ws.addEventListener("message", e => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown")
        this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return Promise.race([
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ id, method, params }));
      }),
      sleep(20000).then(() => { throw Error("CDP timeout: " + method); })
    ]);
  }
  async evaluate(expr) {
    const answer = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (answer.exceptionDetails) throw Error(
      answer.exceptionDetails.exception?.description || answer.exceptionDetails.text
    );
    return answer.result.value;
  }
  close() { this.ws.close(); }
}
async function until(fn, label, ms = 20000) {
  const t = Date.now(); let last;
  while (Date.now() - t < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(175);
  }
  throw Error("Timeout: " + label + " (" + JSON.stringify(last) + ")");
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return new CDP(ws);
}
async function bounds(c, selector) {
  const js = "(() => { const e=document.querySelector(" + JSON.stringify(selector) +
    "); if(!e) throw Error('Missing element'); const b=e.getBoundingClientRect();" +
    " return {x:b.x,y:b.y,w:b.width,h:b.height}; })()";
  const b = await c.evaluate(js);
  if (b.w < 1 || b.h < 1) throw Error("Hidden element: " + selector);
  return b;
}
async function mouse(c, type, x, y, buttons = 0) {
  await c.send("Input.dispatchMouseEvent", {
    type, x: Math.round(x), y: Math.round(y),
    button: type === "mouseMoved" ? "none" : "left", buttons,
    clickCount: type === "mouseMoved" ? 0 : 1
  });
}
async function click(c, selector) {
  const b = await bounds(c, selector);
  const x = b.x + b.w / 2, y = b.y + b.h / 2;
  await mouse(c,"mouseMoved",x,y);
  await mouse(c,"mousePressed",x,y,1);
  await mouse(c,"mouseReleased",x,y);
}
async function draw(c, ax, ay, bx, by) {
  const b = await bounds(c, "#paint-canvas");
  const p = (x,y) => [b.x+x*b.w,b.y+y*b.h];
  let [x,y] = p(ax,ay);
  await mouse(c,"mouseMoved",x,y);
  await mouse(c,"mousePressed",x,y,1);
  for(let i=1;i<=14;i++){
    [x,y]=p(ax+(bx-ax)*i/14,ay+(by-ay)*i/14);
    await mouse(c,"mouseMoved",x,y,1);
  }
  await mouse(c,"mouseReleased",x,y);
  await sleep(250);
}
const STATS = "(() => { const c=document.querySelector('#paint-canvas');" +
  "const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;" +
  "let count=0,darkness=0;for(let i=0;i<p.length;i+=4){" +
  "const d=765-p[i]-p[i+1]-p[i+2];if(d>50)count++;darkness+=Math.max(0,d)}" +
  "return {count,darkness};})()";
async function shot(c,name) {
  const r=await c.send("Page.captureScreenshot",{format:"png"});
  await writeFile(path.join("test-artifacts",name),Buffer.from(r.data,"base64"));
}
async function savedArtwork(c) {
  return c.evaluate(`new Promise((resolve,reject) => {
    const request = indexedDB.open("pfx-paint-studio", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("artwork", "readonly");
      const read = tx.objectStore("artwork").get("current");
      read.onsuccess = () => {
        const value = read.result;
        db.close();
        resolve(value ? {
          schemaVersion: value.schemaVersion,
          width: value.width,
          height: value.height,
          strokes: value.history.length,
          firstStrokePoints: value.history[0]?.points.length || 0,
          redo: value.redoStack.length
        } : null);
      };
      read.onerror = () => reject(read.error);
    };
  })`);
}
async function reloadReady(c) {
  await c.send("Page.reload",{ignoreCache:true});
  await until(async() => (await c.evaluate("document.querySelector('#status')?.textContent || ''")).includes("restored"), "Local artwork recovered", 30000);
}
function assert(x,message){if(!x)throw Error(message);console.log("PASS",message)}
let page,browser;
try {
  const wsUrl=await until(async()=>{
    const r=await fetch("http://127.0.0.1:"+PORT+"/json/list");
    const j=await r.json();
    return j.find(x=>x.type==="page")?.webSocketDebuggerUrl;
  },"Chrome port",18000);
  page=await connect(wsUrl);
  const version=await (await fetch("http://127.0.0.1:"+PORT+"/json/version")).json();
  browser=await connect(version.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await browser.send("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:DOWNLOADS});
  await page.send("Page.navigate",{url:URL});
  await until(async()=>(await page.evaluate("document.querySelector('#status')?.textContent || ''")).includes("Ready to paint"),"WASM ready",30000);
  assert((await page.evaluate("document.querySelector('.alpha-badge')?.textContent")).includes("ALPHA"),"Alpha badge");
  assert(await page.evaluate("document.querySelector('.brand-mark')?.complete"),"Local brand logo");
  assert((await page.evaluate("document.querySelectorAll('.brush-card').length")) === 12, "Twelve local brushes available");
  await until(async () => await page.evaluate("(() => { const c=document.querySelector('[data-brush=\"charcoal\"] .brush-preview'); const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return p.some((v,i)=>i%4===3&&v>0); })()"), "Hokusai generated brush thumbnails", 15000);
  // Custom cursor follows the actual artwork position without touching pixels.
  const cursorCenter = await bounds(page,"#paint-canvas");
  const px = cursorCenter.x + cursorCenter.w * .55, py = cursorCenter.y + cursorCenter.h * .51;
  await mouse(page,"mouseMoved",px,py);
  assert(await page.evaluate("document.querySelector('.artboard-stage').classList.contains('cursor-active')"),"Native paint cursor replaced by custom desktop pointer");
  assert((await page.evaluate("document.querySelector('#paint-pointer').dataset.mode"))==="brush","Brush ring mode available");
  const ringBefore=await page.evaluate("parseFloat(getComputedStyle(document.querySelector('#paint-pointer .cursor-ring')).width)");
  assert(ringBefore>=1.5,"Nominal brush diameter renders at fine detail sizes");
  const cursorSpec = await page.evaluate(`(() => {const b=document.querySelector('#paint-canvas').getBoundingClientRect();const r=document.querySelector('#paint-pointer .cursor-ring').getBoundingClientRect();return {width:b.width,actual:r.width,artworkWidth:1200};})()`);
  assert(Math.abs(cursorSpec.actual-ringBefore)<0.1,"Brush cursor retains precise CSS sizing");
  await page.evaluate("(() => {const i=document.querySelector('#size');i.value='1';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const ringAfter=await page.evaluate("parseFloat(getComputedStyle(document.querySelector('#paint-pointer .cursor-ring')).width)");
  assert(ringAfter>ringBefore*2.57 && ringAfter<ringBefore*2.83,"Pointer diameter tracks brush size logarithmically");
  assert((await page.evaluate("document.querySelector('#size-label').textContent")) === "272%", "Brush size indicator matches actual radius scaling");
  await page.evaluate("(() => {const i=document.querySelector('#size');i.value='0';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await shot(page,"desktop-pointer.png");
  await click(page,"#tool-picker");
  await mouse(page,"mouseMoved",px,py);
  assert((await page.evaluate("document.querySelector('#paint-pointer').dataset.mode"))==="picker","Eyedropper shows its own pointer");
  await click(page,"#tool-eraser");
  await mouse(page,"mouseMoved",px,py);
  assert((await page.evaluate("document.querySelector('#paint-pointer').dataset.mode"))==="eraser","Eraser shows dashed diameter ring");
  await click(page,"#tool-brush");
  await mouse(page,"mouseMoved",px,py);
  assert((await page.evaluate("document.querySelector('#paint-pointer').dataset.mode"))==="brush","Brush ring restores on tool change");
  assert((await page.evaluate("document.querySelector('#zoom-label').textContent"))==="100%", "Canvas initially fits viewport");
  await click(page, "#zoom-in");
  assert((await page.evaluate("document.querySelector('#zoom-label').textContent"))==="125%", "Zoom in button increases view to 125%");
  await mouse(page,"mouseMoved",px,py);
  const cursorSizeAtZoom = await page.evaluate("parseFloat(getComputedStyle(document.querySelector('#paint-pointer .cursor-ring')).width)");
  assert(cursorSizeAtZoom>ringBefore*1.2 && cursorSizeAtZoom<ringBefore*1.3,"Cursor diameter tracks artwork zoom");
  const beforePan = await page.evaluate("document.querySelector('#artboard-frame').style.transform");
  const artbox = await bounds(page, "#paint-canvas");
  const mx = artbox.x + artbox.w / 2, my = artbox.y + artbox.h / 2;
  await page.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:mx,y:my,button:"none",buttons:0});
  await page.send("Input.dispatchMouseEvent",{type:"mousePressed",x:mx,y:my,button:"middle",buttons:4,clickCount:1});
  assert((await page.evaluate("document.querySelector('#paint-pointer').dataset.mode"))==="grabbing","Closed hand cursor during panning");
  await page.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:mx+65,y:my+30,button:"none",buttons:4});
  await page.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:mx+65,y:my+30,button:"middle",buttons:0,clickCount:1});
  assert((await page.evaluate("document.querySelector('#artboard-frame').style.transform"))!==beforePan, "Middle-mouse pan moves canvas");
  assert((await page.evaluate(STATS)).count===0, "Panning does not mark the drawing");
  await click(page, "#zoom-fit");
  assert((await page.evaluate("document.querySelector('#zoom-label').textContent"))==="100%", "Fit returns canvas to 100%");
  await page.evaluate("document.querySelector('[data-brush=\"watercolor_glazing\"]').scrollIntoView({block:'nearest'})");
  await click(page, '[data-brush="watercolor_glazing"]');
  assert(await page.evaluate("document.querySelector('[data-brush=\"watercolor_glazing\"]').classList.contains('selected')"),"New watercolour brush selected");
  await page.evaluate("document.querySelector('[data-brush=\"charcoal\"]').scrollIntoView({block:'nearest'})");
  await click(page, '[data-brush="charcoal"]');
  const ui = await page.evaluate(`(() => {
    const b = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom }; };
    return { stage:b(".artboard-stage"), paper:b("#artboard-frame"), sidebar:b(".inspector"),
      brush:b(".brush-section"), palette:b(".colour-section"), sizing:b(".size-section"),
      topbar:b(".topbar"), save:b("#save"), doc:b(".workspace-heading"),
      bg:getComputedStyle(document.querySelector(".workspace")).backgroundImage,
      bgSize:getComputedStyle(document.querySelector(".workspace")).backgroundSize,
      noOverflow: document.documentElement.scrollWidth<=innerWidth+2 && document.documentElement.scrollHeight<=innerHeight+2 };
  })()`);
  assert(ui.bg.includes("radial-gradient") && ui.bgSize === "cover", "Smooth, un-tiled graphite workbench background");
  assert(ui.paper.x>=ui.stage.x-3 && ui.paper.right<=ui.stage.right+3 &&
    ui.paper.y>=ui.stage.y-3 && ui.paper.bottom<=ui.stage.bottom+3, "Artboard fits inside workbench without clipping");
  assert(ui.palette.y>ui.brush.y && ui.sizing.y>ui.palette.y &&
    ui.sizing.bottom<=ui.sidebar.bottom+2,"Brush, colour and size controls are ordered and visible");
  assert(ui.noOverflow, "Desktop interface has no page scroll");
  const outside = await page.evaluate(`(async()=>{
    const { PaintingEngine } = await import("./src/engine.js");
    const sample = PaintingEngine.prototype.sample;
    const receiver = {canvas:{width:1200,height:800}};
    const rect = {left:0,top:0,width:100,height:100};
    const a = sample.call(receiver,{clientX:-100000,clientY:100000,pointerType:"mouse",timeStamp:42},rect);
    const b = sample.call(receiver,{clientX:100000,clientY:-100000,pointerType:"mouse",timeStamp:43},rect);
    return [a.x,a.y,b.x,b.y];
  })()`);
  assert(outside.join(",")==="-64,864,1264,-64","Off-canvas pointer capture stays inside safe tile margin");

  // A pen-up event reports pressure 0. Verify that the final input retains
  // that value and that native Hokusai replay remains pixel-exact.
  const penLift = await page.evaluate(`(async () => {
    const { PaintingEngine } = await import("./src/engine.js");
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 200;
    const paint = await PaintingEngine.create(canvas, () => {});
    const rect = { left:0, top:0, width:320, height:200 };
    const pen = (x,y,pressure,time) => ({
      clientX:x, clientY:y, pressure, timeStamp:time, pointerType:"pen",
      tiltX:12, tiltY:-8
    });
    const liftPressure = paint.sample(pen(180,110,0,1030),rect).pressure;
    const mousePressure = paint.sample({ ...pen(180,110,0,1030), pointerType:"mouse" },rect).pressure;
    paint.configure({ brushId:"calligraphy" });
    paint.begin(pen(30,65,0.25,1000),rect);
    paint.add(pen(110,85,0.8,1010),rect);
    paint.add(pen(180,110,0.35,1020),rect);
    paint.add(pen(180,110,0,1030),rect);
    paint.end();
    const points = paint.history[0].points;
    const lastPressure = points.at(-1).pressure;
    const hasPressureVariation = points.some(p => p.pressure > 0.5) &&
      points.some(p => p.pressure > 0 && p.pressure < 0.5);
    const fingerprint = (engine) => {
      engine.renderNow();
      const data = engine.context.getImageData(0,0,320,200).data;
      let hash = 2166136261, ink = false;
      for(let i=0;i<data.length;i+=4) {
        if(data[i]<240 || data[i+1]<240 || data[i+2]<240) ink = true;
        hash = Math.imul(hash ^ data[i],16777619) >>> 0;
        hash = Math.imul(hash ^ data[i+1],16777619) >>> 0;
        hash = Math.imul(hash ^ data[i+2],16777619) >>> 0;
      }
      return { hash, ink };
    };
    const before = fingerprint(paint);
    const saved = paint.snapshot();
    paint.undo(); paint.redo();
    const redone = fingerprint(paint);
    const cloneCanvas = document.createElement("canvas");
    cloneCanvas.width = 320; cloneCanvas.height = 200;
    const clone = new PaintingEngine(cloneCanvas,paint.wasm,paint.brushSources,()=>{});
    clone.restoreArtwork(saved);
    const recovered = fingerprint(clone);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for(const engine of [paint,clone]) {
      engine.releaseCheckpoints(); engine.active.free(); engine.surface.free();
    }
    return { liftPressure, mousePressure, lastPressure, hasPressureVariation,
      ink:before.ink, exactRedo:before.hash===redone.hash,
      exactRestore:before.hash===recovered.hash };
  })()`);
  assert(penLift.liftPressure===0 && penLift.lastPressure===0,
    "Pen lift-off retains zero pressure instead of producing a full-pressure dab");
  assert(penLift.mousePressure===1 && penLift.hasPressureVariation && penLift.ink,
    "Pen pressure dynamics stay intact and mouse pressure remains unchanged");
  assert(penLift.exactRedo && penLift.exactRestore,
    "Zero-pressure pen stroke restores pixel-exactly after undo/redo and reload");

  const dirtyCheck = await page.evaluate(`(async () => {
    const api = await import("./pkg/hokusai_wasm.js");
    const wasm = await api.default();
    const source = await (await fetch("./public/brushes/brush.myb")).text();
    const brush = new api.HokusaiBrush(source);
    const surface = new api.HokusaiCanvas(1200, 800);
    const initial = Array.from(surface.flushDirtyPixels());
    surface.strokeTo(brush, 500, 400, 1, 0, 0, 0.01);
    surface.strokeTo(brush, 545, 420, 1, 0, 0, 0.016);
    surface.finishStroke(brush);
    const region = Array.from(surface.flushDirtyPixels());
    const buffer = new Uint8Array(wasm.memory.buffer, surface.pixelsPtr(), surface.pixelsLen());
    const incremental = new Uint8Array(buffer);
    surface.flush_pixels();
    const full = new Uint8Array(wasm.memory.buffer, surface.pixelsPtr(), surface.pixelsLen());
    let equal = incremental.length === full.length;
    if (equal) for (let i = 0; i < full.length; i++) {
      if (incremental[i] !== full[i]) { equal = false; break; }
    }
    const empty = Array.from(surface.flushDirtyPixels());
    surface.clear();
    const cleared = Array.from(surface.flushDirtyPixels());
    surface.free();
    brush.free();
    return { initial, region, equal, empty, cleared };
  })()`);
  assert(dirtyCheck.initial.join(",")==="0,0,1200,800","New surfaces provide initial full frame");
  assert(dirtyCheck.region.length===4 && dirtyCheck.region[2]*dirtyCheck.region[3] < 1200*800/4,
    "Brush work updates only a small dirty region");
  assert(dirtyCheck.equal,"Incremental pixels match exact full-resolution render");
  assert(dirtyCheck.empty.length===0,"No redundant frames without changes");
  assert(dirtyCheck.cleared.join(",")==="0,0,1200,800","Clear invalidates entire artboard");

  // Checkpoint equivalence after 26 separate completed strokes.
  // This exercises the fast Undo/Redo path absent from three-stroke smoke tests.
  const checkpointTest = await page.evaluate(`(async () => {
    const { PaintingEngine } = await import("./src/engine.js");
    const surface = document.createElement("canvas");
    surface.width = 1200; surface.height = 800;
    const paint = await PaintingEngine.create(surface, () => {});
    const rect = { left:0, top:0, width:1200, height:800 };
    const event = (x,y,t) => ({
      clientX:x, clientY:y, timeStamp:t, pressure:1, pointerType:"mouse",
      tiltX:0, tiltY:0
    });
    for (let i=0;i<26;i++) {
      const y=140+i*17,t=1000+i*120;
      paint.begin(event(130,y,t),rect);
      paint.add(event(310,y,t+60),rect);
      paint.end();
    }
    const checkpoints=paint.checkpoints.map(c=>c.count);
    const fingerprint=() => {
      paint.renderNow();
      const data=paint.context.getImageData(0,0,1200,800).data;
      let hash=2166136261;
      for(let i=0;i<data.length;i+=4){
        hash=Math.imul(hash ^ data[i],16777619)>>>0;
        hash=Math.imul(hash ^ data[i+1],16777619)>>>0;
      }
      return hash;
    };
    const before=fingerprint(),start=performance.now();
    paint.undo();
    const undone=fingerprint(),undoMs=performance.now()-start;
    paint.redo();
    const redone=fingerprint();
    paint.clear();
    const freed=paint.checkpoints.length===0;
    // Let queued animation frames finish before releasing the WASM canvas.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    paint.active.free();
    paint.surface.free();
    return {checkpoints,before,undone,redone,undoMs,freed};
  })()`);
  assert(checkpointTest.checkpoints.includes(24),"Checkpoint created for long stroke history");
  assert(checkpointTest.before!==checkpointTest.undone &&
    checkpointTest.before===checkpointTest.redone,"Checkpointed Undo/Redo preserves exact painted pixels");
  assert(checkpointTest.freed,"Clearing frees cached surface checkpoints");
  console.log("PERF checkpointed undo (26 strokes): "+checkpointTest.undoMs.toFixed(2)+" ms");

  await shot(page,"desktop-before.png");
  const blank=await page.evaluate(STATS);
  assert(blank.count===0,"Blank white canvas");

  await draw(page,.25,.35,.72,.62);
  const painted=await page.evaluate(STATS);
  assert(painted.count>50,"Drawing paints actual pixels ("+painted.count+")");
  assert(!(await page.evaluate("document.querySelector('#undo').disabled")),"Undo enabled");
  const sampled = await until(async () => {
    const item = await savedArtwork(page);
    return item?.strokes === 1 && item.firstStrokePoints > 30 ? item : null;
  }, "Fast pointer trajectory spatially resampled and saved");
  assert(sampled.firstStrokePoints > 30,"Sparse high-speed mouse events receive intermediate samples");
  await shot(page,"desktop-painted.png");

  await click(page,"#undo");
  await until(async()=>(await page.evaluate(STATS)).count===0,"Undo clears drawn pixels");
  assert(!(await page.evaluate("document.querySelector('#redo').disabled")),"Redo enabled");
  await click(page,"#redo");
  await until(async()=>(await page.evaluate(STATS)).count>50,"Redo restores drawn pixels");

  await click(page,'[data-brush="calligraphy"]');
  assert(await page.evaluate("document.querySelector('[data-brush=\"calligraphy\"]').classList.contains('selected')"),"Ink brush selected");
  await click(page,'[data-color="#d95950"]');
  assert((await page.evaluate("document.querySelector('#color').value"))==="#d95950","Colour selected");
  await draw(page,.2,.78,.66,.78);
  const twice=await page.evaluate(STATS);
  assert(twice.count>painted.count,"Second brush adds visible pigment");

  await click(page,"#tool-eraser");
  assert((await page.evaluate("document.querySelector('#tool-eraser').getAttribute('aria-pressed')"))==="true","Eraser selected");
  await draw(page,.25,.35,.72,.62);
  const erased=await page.evaluate(STATS);
  assert(erased.darkness<twice.darkness,"Eraser removes pigment");

  await click(page,"#save");
  const file=await until(async()=>{
    const files=await readdir(DOWNLOADS);
    const name=files.find(f=>f.endsWith(".png"));
    return name && path.join(DOWNLOADS,name);
  },"PNG download",15000);
  const png=await until(async()=>{
    const bytes=await readFile(file);
    return bytes.length>100?bytes:null;
  },"PNG bytes",15000);
  assert(png.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")),"Valid PNG signature");
  assert(png.readUInt32BE(16)===1200 && png.readUInt32BE(20)===800,"PNG full 1200x800 resolution");
  const external=await page.evaluate("performance.getEntriesByType('resource').filter(x=>new URL(x.name).origin!==location.origin).map(x=>x.name)");
  assert(external.length===0,"Zero external runtime requests");

  const saved = await until(async() => {
    const item = await savedArtwork(page);
    return item?.strokes === 3 && item.redo === 0 ? item : null;
  }, "Completed strokes saved in IndexedDB");
  assert(saved.schemaVersion===1 && saved.width===1200 && saved.height===800, "Local save schema and artwork dimensions");
  const beforeReload = await page.evaluate(STATS);
  await reloadReady(page);
  const recovered = await page.evaluate(STATS);
  assert(recovered.count > 50 &&
    Math.abs(recovered.count-beforeReload.count) < Math.max(50, beforeReload.count*0.25),
    "Real painted pixels recovered after reload");
  assert(!(await page.evaluate("document.querySelector('#undo').disabled")), "Undo available after recovery");

  await click(page,"#undo");
  await until(async()=>{const item=await savedArtwork(page);return item?.strokes===2&&item.redo===1}, "Undo autosaved");
  await reloadReady(page);
  assert(!(await page.evaluate("document.querySelector('#redo').disabled")), "Redo history recovered after reload");
  await click(page,"#redo");
  await until(async()=>{const item=await savedArtwork(page);return item?.strokes===3&&item.redo===0}, "Redo autosaved");

  // Exercise clear with no visible strokes, but a nonempty redo history.
  await click(page,"#undo");
  await click(page,"#undo");
  await click(page,"#undo");
  await until(async()=>{const v=await savedArtwork(page);return v?.strokes===0&&v.redo===3}, "Undo-only history autosaved");
  await page.evaluate("window.confirm = () => true");
  await click(page,"#clear");
  await until(async()=>{const v=await savedArtwork(page);return v?.strokes===0&&v.redo===0}, "Clear removes redo-only history");
  assert(await page.evaluate("document.querySelector('#redo').disabled"), "Redo disabled after clearing undone artwork");

  await page.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(350);
  const mobile=await page.evaluate("({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight,iw:innerWidth,ih:innerHeight,b:(()=>{const b=document.querySelector('#paint-canvas').getBoundingClientRect();return b.width>100&&b.height>60})()})");
  assert(mobile.w<=mobile.iw+2,"390px viewport without horizontal overflow");
  assert(mobile.h<=mobile.ih+2,"844px viewport without vertical overflow");
  assert(mobile.b,"Drawing surface visible on mobile");
  assert(!(await page.evaluate("document.querySelector('.artboard-stage').classList.contains('cursor-active')")),"Desktop cursor is disabled on mobile");
  await shot(page,"mobile.png");

  await page.evaluate("window.confirm = () => true");
  await click(page,"#clear");
  await until(async()=>{const item=await savedArtwork(page);return item?.strokes===0&&item.redo===0}, "Clear operation autosaved");
  await page.send("Page.reload",{ignoreCache:true});
  await until(async()=>(await page.evaluate("document.querySelector('#status')?.textContent || ''")).includes("Ready to paint"),"Empty artwork reopened",30000);
  assert((await page.evaluate(STATS)).count===0,"Cleared artwork remains empty after reload");
  await page.send("Emulation.clearDeviceMetricsOverride");
  await sleep(150);
  // Verify that invalid data is backed up before a new session can write.
  await page.evaluate(`new Promise((resolve,reject)=>{
    const request=indexedDB.open("pfx-paint-studio",1);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result;
      const tx=db.transaction("artwork","readwrite");
      tx.objectStore("artwork").put({schemaVersion:1,width:1200,height:800,history:"damaged",redoStack:[]}, "current");
      tx.oncomplete=()=>{db.close();resolve(true)};
      tx.onerror=()=>reject(tx.error);
    };
  })`);
  await page.send("Page.reload",{ignoreCache:true});
  await until(async()=>await page.evaluate("document.querySelector('#autosave-status')?.textContent === 'Backup preserved'"),"Invalid artwork recognized");
  const damagedRecord=await page.evaluate(`new Promise((resolve,reject)=>{
    const request=indexedDB.open("pfx-paint-studio",1);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction("artwork","readonly");
      const get=tx.objectStore("artwork").get("unreadable-backup");
      get.onsuccess=()=>{const value=get.result;db.close();resolve(value?.history || null)};
      get.onerror=()=>reject(get.error);
    };
  })`);
  assert(damagedRecord==="damaged","Unreadable artwork preserved independently of active autosave");
  assert(page.errors.length===0,"No uncaught JS exceptions: "+page.errors.join("; "));
  console.log("ALL BROWSER INTERACTION TESTS PASSED");
} catch(e) {
  console.error("BROWSER TEST FAILED",e.stack||e);
  console.error("CHROME LOG",chromeLog);
  process.exitCode=1;
} finally {
  page?.close(); browser?.close(); chrome.kill("SIGTERM");
  await sleep(250);
  await rm(ROOT,{recursive:true,force:true}).catch(()=>{});
}
