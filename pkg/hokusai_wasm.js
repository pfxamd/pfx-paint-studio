/* @ts-self-types="./hokusai_wasm.d.ts" */

export class HokusaiBrush {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HokusaiBrushFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hokusaibrush_free(ptr, 0);
    }
    /**
     * Parse a `.myb` JSON document.
     * @param {string} myb_json
     */
    constructor(myb_json) {
        const ptr0 = passStringToWasm0(myb_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hokusaibrush_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        HokusaiBrushFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Read the brush's designed radius (its `radius_logarithmic` base
     * value). Useful for UIs that want to offset from the natural size
     * rather than override it outright.
     * @returns {number}
     */
    radiusLog() {
        const ret = wasm.hokusaibrush_radiusLog(this.__wbg_ptr);
        return ret;
    }
    /**
     * Override the HSV base colour (each channel in [0, 1]).
     * @param {number} h
     * @param {number} s
     * @param {number} v
     */
    setColorHsv(h, s, v) {
        wasm.hokusaibrush_setColorHsv(this.__wbg_ptr, h, s, v);
    }
    /**
     * Toggle erasing while preserving the selected brush's spacing and shape.
     * @param {boolean} enabled
     */
    setEraser(enabled) {
        wasm.hokusaibrush_setEraser(this.__wbg_ptr, enabled);
    }
    /**
     * Override the base radius (libmypaint's `radius_logarithmic`, log2 px).
     * @param {number} log2_radius
     */
    setRadiusLog(log2_radius) {
        wasm.hokusaibrush_setRadiusLog(this.__wbg_ptr, log2_radius);
    }
    /**
     * Keep mouse input responsive without changing the original brush preset.
     * Only the slow-tracking base is capped; per-dab brush character remains.
     */
    setResponsiveMouse() {
        wasm.hokusaibrush_setResponsiveMouse(this.__wbg_ptr);
    }
}
if (Symbol.dispose) HokusaiBrush.prototype[Symbol.dispose] = HokusaiBrush.prototype.free;

/**
 * A drawable canvas. Holds the tiled surface, an active [`BrushState`],
 * and the RGBA8 output buffer reused across `pixels()` calls.
 */
export class HokusaiCanvas {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HokusaiCanvasFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hokusaicanvas_free(ptr, 0);
    }
    /**
     * Clone the tiled surface and brush state after a completed stroke.
     * @returns {HokusaiCheckpoint}
     */
    checkpoint() {
        const ret = wasm.hokusaicanvas_checkpoint(this.__wbg_ptr);
        return HokusaiCheckpoint.__wrap(ret);
    }
    /**
     * Drop all painted tiles and restore the initial RNG stream.
     * Unlike reset_stroke(), a full clear is used before deterministic
     * replay from an empty canvas. Preserving the advanced RNG here
     * changes dry/textured brush dabs on undo and redo.
     */
    clear() {
        wasm.hokusaicanvas_clear(this.__wbg_ptr);
    }
    /**
     * Flush `slow_tracking` lag so the stroke's trailing pixels are painted.
     * Call on pointer-up *before* resetting.
     * @param {HokusaiBrush} brush
     */
    finishStroke(brush) {
        _assertClass(brush, HokusaiBrush);
        wasm.hokusaicanvas_finishStroke(this.__wbg_ptr, brush.__wbg_ptr);
    }
    /**
     * Update only tiles affected since the last flush. Returns a small
     * [x, y, width, height] dirty region in artwork pixel coordinates.
     * Empty means no visible pixel data has changed.
     * @returns {Uint32Array}
     */
    flushDirtyPixels() {
        const ret = wasm.hokusaicanvas_flushDirtyPixels(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Pointer + length accessors for callers that want to skip the
     * `pixels()` copy entirely: JS can construct
     * `new Uint8Array(memory.buffer, canvas.pixels_ptr(),
     * canvas.pixels_len())` and `ImageData.data.set` directly from
     * wasm memory. Call `flush_pixels()` first to refresh the buffer.
     */
    flush_pixels() {
        wasm.hokusaicanvas_flush_pixels(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.hokusaicanvas_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} width
     * @param {number} height
     */
    constructor(width, height) {
        const ret = wasm.hokusaicanvas_new(width, height);
        this.__wbg_ptr = ret;
        HokusaiCanvasFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    pixelsLen() {
        const ret = wasm.hokusaicanvas_pixelsLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    pixelsPtr() {
        const ret = wasm.hokusaicanvas_pixelsPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Return the canvas as RGBA8 in sRGB, composited over white.
     * JS copies via `ImageData.data.set(canvas.pixels())`. wasm-bindgen
     * can't return a borrowed slice across the JS boundary, so the
     * `Vec<u8>` materialisation is forced; the underlying `flatten` writes
     * in-place into the canvas's own buffer first, so the per-frame cost
     * is one memcpy into the JS Uint8Array.
     * @returns {Uint8Array}
     */
    pixels() {
        const ret = wasm.hokusaicanvas_pixels(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * End the current stroke so the next `strokeTo` starts fresh.
     */
    resetStroke() {
        wasm.hokusaicanvas_resetStroke(this.__wbg_ptr);
    }
    /**
     * Restore a known tile checkpoint, invalidating the full output buffer.
     * @param {HokusaiCheckpoint} saved
     */
    restoreCheckpoint(saved) {
        _assertClass(saved, HokusaiCheckpoint);
        wasm.hokusaicanvas_restoreCheckpoint(this.__wbg_ptr, saved.__wbg_ptr);
    }
    /**
     * Install a validated local tile checkpoint, returning false when
     * corrupt/obsolete. The existing history remains the recovery source.
     * @param {Uint8Array} data
     * @returns {boolean}
     */
    restoreTiles(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hokusaicanvas_restoreTiles(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Feed one pointer event. `dtime` is seconds since the previous call.
     *
     * `xtilt` / `ytilt` are pen tilt in [-1, 1], matching libmypaint's
     * convention. Pass 0 for devices that don't report tilt.
     * @param {HokusaiBrush} brush
     * @param {number} x
     * @param {number} y
     * @param {number} pressure
     * @param {number} xtilt
     * @param {number} ytilt
     * @param {number} dtime
     */
    strokeTo(brush, x, y, pressure, xtilt, ytilt, dtime) {
        _assertClass(brush, HokusaiBrush);
        wasm.hokusaicanvas_strokeTo(this.__wbg_ptr, brush.__wbg_ptr, x, y, pressure, xtilt, ytilt, dtime);
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.hokusaicanvas_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) HokusaiCanvas.prototype[Symbol.dispose] = HokusaiCanvas.prototype.free;

/**
 * A compact in-memory checkpoint of the brush surface. This never leaves the
 * browser, and excludes the full RGBA preview buffer.
 */
export class HokusaiCheckpoint {
    static __wrap(ptr) {
        const obj = Object.create(HokusaiCheckpoint.prototype);
        obj.__wbg_ptr = ptr;
        HokusaiCheckpointFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HokusaiCheckpointFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hokusaicheckpoint_free(ptr, 0);
    }
    /**
     * Export an exact 16-bit tiled surface, not an 8-bit preview image.
     * @param {number} width
     * @param {number} height
     * @returns {Uint8Array}
     */
    exportTiles(width, height) {
        const ret = wasm.hokusaicheckpoint_exportTiles(this.__wbg_ptr, width, height);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) HokusaiCheckpoint.prototype[Symbol.dispose] = HokusaiCheckpoint.prototype.free;

export function start() {
    wasm.start();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_dce373f2e4600c63: function(arg0, arg1) {
            console.error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./hokusai_wasm_bg.js": import0,
    };
}

const HokusaiBrushFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hokusaibrush_free(ptr, 1));
const HokusaiCanvasFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hokusaicanvas_free(ptr, 1));
const HokusaiCheckpointFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hokusaicheckpoint_free(ptr, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('hokusai_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
