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
    throw new Error("Saved artwork is incompatible or damaged");
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

export function createAutosave(db, onStatus) {
  let pending = null;
  let writing = false;

  async function flush() {
    if (writing) return;
    writing = true;
    try {
      while (pending) {
        const next = pending;
        pending = null;
        await writeArtwork(db, next);
      }
      onStatus("Saved locally");
    } catch (error) {
      console.error("PFx Paint local save failed:", error);
      onStatus("Save failed");
    } finally {
      writing = false;
      if (pending) void flush();
    }
  }

  return {
    save(snapshot) {
      pending = snapshot;
      onStatus("Saving…");
      void flush();
    }
  };
}
