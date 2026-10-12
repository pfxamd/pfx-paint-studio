// Local artwork persistence. No network requests or external dependencies.
import { BRUSHES } from "./engine.js";
const DATABASE = "pfx-paint-studio";
const STORE = "artwork";
const DOCUMENT = "current";
const VERSION = 1;
const BRUSH_IDS = new Set(BRUSHES.map((brush) => brush.id));
const COLOR = /^#[0-9a-fA-F]{6}$/;

function validStroke(stroke) {
  return stroke && typeof stroke === "object" &&
    BRUSH_IDS.has(stroke.brushId) && COLOR.test(stroke.color) &&
    Number.isFinite(stroke.size) && typeof stroke.eraser === "boolean" &&
    (!("inputType" in stroke) || ["mouse", "pen", "touch"].includes(stroke.inputType)) &&
    Array.isArray(stroke.points) && stroke.points.length > 0 &&
    stroke.points.every((point) => point && typeof point === "object" &&
      ["x", "y", "pressure", "xtilt", "ytilt", "time", "dt"]
        .every((key) => Number.isFinite(point[key])));
}

export function openArtworkDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onerror = () => reject(request.error || Error("Could not open local artwork"));
    request.onblocked = () => reject(Error("Local artwork database is blocked"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export async function loadArtwork(db, width, height) {
  const saved = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(DOCUMENT);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || Error("Could not read local artwork"));
    tx.onabort = () => reject(tx.error || Error("Local artwork read aborted"));
  });
  if (!saved) return null;
  if (saved.schemaVersion !== VERSION || saved.width !== width ||
      saved.height !== height || !Array.isArray(saved.history) ||
      !Array.isArray(saved.redoStack) ||
      !saved.history.every(validStroke) || !saved.redoStack.every(validStroke)) {
    const error = new Error("Saved artwork is incompatible or damaged");
    error.name = "InvalidArtworkError";
    throw error;
  }
  return saved;
}

function writeArtwork(db, snapshot) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || Error("Local artwork save aborted"));
    try {
      tx.objectStore(STORE).put({
        ...snapshot,
        schemaVersion: VERSION,
        savedAt: Date.now()
      }, DOCUMENT);
    } catch (error) {
      reject(error);
      tx.abort();
    }
  });
}

/**
 * Preserve damaged/incompatible data before starting a new autosaved document.
 * Never overwrite an earlier emergency backup with subsequent failed loads.
 */
export function backupInvalidArtwork(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const backupKey = "unreadable-backup";
    const backup = store.get(backupKey);
    backup.onsuccess = () => {
      if (backup.result !== undefined) return;
      const original = store.get(DOCUMENT);
      original.onsuccess = () => {
        if (original.result !== undefined) store.put(original.result, backupKey);
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || Error("Could not preserve damaged artwork"));
    tx.onabort = () => reject(tx.error || Error("Artwork backup transaction aborted"));
  });
}

/**
 * Coalesced, lazy snapshots prevent synchronous O(history) clones for every
 * rapid stroke. On failure the latest unsaved document is retained and retried
 * with bounded exponential backoff, never a hot synchronous retry loop.
 */
export function createAutosave(db, onStatus) {
  let pending = null;
  let timer = null;
  let writing = false;
  let failures = 0;

  function schedule(delay) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  }

  async function flush() {
    if (writing || !pending) return;
    writing = true;
    try {
      while (pending) {
        const makeSnapshot = pending;
        pending = null;
        try {
          await writeArtwork(db, await makeSnapshot());
          failures = 0;
        } catch (error) {
          // Another completed stroke may already have replaced this snapshot.
          if (!pending) pending = makeSnapshot;
          failures += 1;
          console.error("PFx Paint local save failed:", error);
          onStatus("Save failed");
          schedule(Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)));
          return;
        }
      }
      onStatus("Saved locally");
    } finally {
      writing = false;
      if (pending && timer === null) schedule(0);
    }
  }

  function onPageHidden() {
    if (document.visibilityState === "hidden" && pending) schedule(0);
  }
  document.addEventListener("visibilitychange", onPageHidden);

  return {
    save(makeSnapshot) {
      if (typeof makeSnapshot !== "function") {
        throw new TypeError("Autosave expects a snapshot producer");
      }
      pending = makeSnapshot;
      onStatus("Saving…");
      schedule(160);
    }
  };
}
