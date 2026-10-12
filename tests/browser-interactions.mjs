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
  assert((await page.evaluate("document.querySelector('#zoom-label').textContent"))==="100%", "Canvas initially fits viewport");
  await click(page, "#zoom-in");
  assert((await page.evaluate("document.querySelector('#zoom-label').textContent"))==="125%", "Zoom in button increases view to 125%");
  const beforePan = await page.evaluate("document.querySelector('#artboard-frame').style.transform");
  const artbox = await bounds(page, "#paint-canvas");
  const mx = artbox.x + artbox.w / 2, my = artbox.y + artbox.h / 2;
  await page.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:mx,y:my,button:"none",buttons:0});
  await page.send("Input.dispatchMouseEvent",{type:"mousePressed",x:mx,y:my,button:"middle",buttons:4,clickCount:1});
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
  await shot(page,"desktop-before.png");
  const blank=await page.evaluate(STATS);
  assert(blank.count===0,"Blank white canvas");

  await draw(page,.25,.35,.72,.62);
  const painted=await page.evaluate(STATS);
  assert(painted.count>50,"Drawing paints actual pixels ("+painted.count+")");
  assert(!(await page.evaluate("document.querySelector('#undo').disabled")),"Undo enabled");
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

  await page.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(350);
  const mobile=await page.evaluate("({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight,iw:innerWidth,ih:innerHeight,b:(()=>{const b=document.querySelector('#paint-canvas').getBoundingClientRect();return b.width>100&&b.height>60})()})");
  assert(mobile.w<=mobile.iw+2,"390px viewport without horizontal overflow");
  assert(mobile.h<=mobile.ih+2,"844px viewport without vertical overflow");
  assert(mobile.b,"Drawing surface visible on mobile");
  await shot(page,"mobile.png");

  await page.evaluate("window.confirm = () => true");
  await click(page,"#clear");
  await until(async()=>{const item=await savedArtwork(page);return item?.strokes===0&&item.redo===0}, "Clear operation autosaved");
  await page.send("Page.reload",{ignoreCache:true});
  await until(async()=>(await page.evaluate("document.querySelector('#status')?.textContent || ''")).includes("Ready to paint"),"Empty artwork reopened",30000);
  assert((await page.evaluate(STATS)).count===0,"Cleared artwork remains empty after reload");
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
