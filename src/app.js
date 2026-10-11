import { PaintingEngine } from "./engine.js";

const $ = (id) => document.getElementById(id);
const canvas = $("paint-canvas");
const frame = $("artboard-frame");
const status = $("status");
const loading = $("loading");
const indicator = $("engine-indicator");
const toast = $("toast");
const color = $("color");
const size = $("size");
const undo = $("undo");
const redo = $("redo");
const toolButtons = Array.from(document.querySelectorAll("[data-tool]"));
const brushButtons = Array.from(document.querySelectorAll("[data-brush]"));
const swatches = Array.from(document.querySelectorAll("[data-color]"));
let engine = null;
let tool = "brush";
let activePointer = null;
let toastTimer = null;
let paintingBusy = false;

function message(text) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}
function updateHistory() {
  undo.disabled = !engine?.canUndo;
  redo.disabled = !engine?.canRedo;
}
function useTool(name) {
  if (!["brush", "eraser", "picker"].includes(name)) return;
  tool = name;
  for (const el of toolButtons) {
    const selected = el.dataset.tool === name;
    el.classList.toggle("active", selected);
    el.setAttribute("aria-pressed", String(selected));
  }
  frame.classList.toggle("eraser", name === "eraser");
  frame.classList.toggle("picker", name === "picker");
  if (engine) engine.configure({ eraser: name === "eraser" });
  status.textContent = name === "picker" ? "Click the artwork to sample a colour" : "Ready to " + (name === "eraser" ? "erase" : "paint");
}
function applyColor(hex) {
  const normalized = hex.toLowerCase();
  color.value = normalized;
  $("hex-label").textContent = normalized.toUpperCase();
  for (const button of swatches) button.classList.toggle("selected", button.dataset.color === normalized);
  $("colour-name").textContent = swatches.find((b) => b.dataset.color === normalized)?.title || "Custom colour";
  if (engine) engine.configure({ color: normalized });
}
function applySize(value) {
  size.value = String(value);
  $("size-label").textContent = Math.round(100 * Math.pow(2, Number(value))) + "%";
  if (engine) engine.configure({ size: Number(value) });
}
function chooseBrush(id) {
  for (const el of brushButtons) {
    const selected = el.dataset.brush === id;
    el.classList.toggle("selected", selected);
    el.setAttribute("aria-pressed", String(selected));
  }
  if (engine) engine.configure({ brushId: id });
  if (tool === "picker") useTool("brush");
}
for (const button of toolButtons) button.addEventListener("click", () => useTool(button.dataset.tool));
for (const button of brushButtons) button.addEventListener("click", () => chooseBrush(button.dataset.brush));
for (const button of swatches) button.addEventListener("click", () => applyColor(button.dataset.color));
color.addEventListener("input", () => applyColor(color.value));
size.addEventListener("input", () => applySize(size.value));
undo.addEventListener("click", () => { if (!paintingBusy) engine?.undo(); });
redo.addEventListener("click", () => { if (!paintingBusy) engine?.redo(); });
$("clear").addEventListener("click", () => {
  if (!engine || paintingBusy || !engine.canUndo) return;
  if (!window.confirm("Clear the entire artwork? This cannot be undone.")) return;
  engine.clear();
  status.textContent = "Canvas cleared";
  message("Fresh canvas ready");
});
$("save").addEventListener("click", () => {
  if (!engine || paintingBusy) return;
  engine.renderNow();
  canvas.toBlob((blob) => {
    if (!blob) return message("Could not save PNG");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "pfx-paint-" + new Date().toISOString().slice(0, 10) + ".png";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message("PNG saved to your device");
  }, "image/png");
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerdown", (event) => {
  if (!engine || activePointer !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  if (tool === "picker") {
    const sampled = engine.pickColor(event, canvas.getBoundingClientRect());
    applyColor(sampled);
    useTool("brush");
    message("Colour sampled: " + sampled.toUpperCase());
    return;
  }
  activePointer = event.pointerId;
  paintingBusy = true;
  const rect = canvas.getBoundingClientRect();
  engine.begin(event, rect);
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!engine || activePointer !== event.pointerId) return;
  const rect = canvas.getBoundingClientRect();
  const subs = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const samples = subs.length ? subs : [event];
  for (const sample of samples) engine.add(sample, rect);
});
function finish(event) {
  if (!engine || activePointer !== event.pointerId) return;
  if (event.type === "pointerup") engine.add(event, canvas.getBoundingClientRect());
  engine.end();
  activePointer = null;
  paintingBusy = false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.addEventListener("pointerup", finish);
canvas.addEventListener("pointercancel", finish);
canvas.addEventListener("lostpointercapture", (event) => {
  if (event.pointerId === activePointer) {
    engine?.end();
    activePointer = null;
    paintingBusy = false;
  }
});
window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))) return;
  const meta = event.ctrlKey || event.metaKey;
  const k = event.key.toLowerCase();
  if (meta && k === "z") {
    event.preventDefault();
    if (event.shiftKey) redo.click();
    else undo.click();
  } else if (meta && k === "y") {
    event.preventDefault();
    redo.click();
  } else if (!meta && !event.altKey) {
    if (k === "b") useTool("brush");
    if (k === "e") useTool("eraser");
    if (k === "i") useTool("picker");
  }
});
async function start() {
  try {
    status.textContent = "Loading local Hokusai engine";
    engine = await PaintingEngine.create(canvas, updateHistory);
    indicator.classList.add("ready");
    document.querySelector(".engine-pulse").classList.add("ready");
    loading.classList.add("hidden");
    updateHistory();
    useTool("brush");
    status.textContent = "Ready to paint — all drawing stays on this device";
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  } catch (error) {
    console.error("PFx Paint engine boot failed:", error);
    indicator.classList.add("error");
    loading.textContent = "Engine failed to load. Refresh to try again.";
    loading.classList.remove("hidden");
    status.textContent = error?.message || "Could not load the local painting engine";
  }
}
start();
