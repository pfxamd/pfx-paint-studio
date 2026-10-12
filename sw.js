const CACHE_NAME = "pfx-paint-cache-v1";
const LOCAL_ASSETS = [
  "./", "./index.html",
  "./src/style.css", "./src/app.js", "./src/engine.js", "./src/viewport.js", "./src/autosave.js",
  "./public/brand/Red-pfx.svg",
  "./public/brushes/charcoal.myb",
  "./public/brushes/calligraphy.myb",
  "./public/brushes/brush.myb",
  "./public/brushes/marker_fat.myb",
  "./public/brushes/pencil.myb",
  "./public/brushes/dry_brush.myb",
  "./public/brushes/textured_ink.myb",
  "./public/brushes/watercolor_glazing.myb",
  "./public/brushes/watercolor_expressive.myb",
  "./public/brushes/oil.myb",
  "./public/brushes/acrylic.myb",
  "./public/brushes/pastel.myb",
  "./pkg/hokusai_wasm.js", "./pkg/hokusai_wasm_bg.wasm"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => cache.addAll(LOCAL_ASSETS))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) =>
      name.startsWith("pfx-paint-cache-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./index.html")));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
