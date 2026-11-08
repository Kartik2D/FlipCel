/* @ts-self-types="./kernel.d.ts" */

export class VectorMap {
    static __wrap(ptr) {
        const obj = Object.create(VectorMap.prototype);
        obj.__wbg_ptr = ptr;
        VectorMapFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        VectorMapFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_vectormap_free(ptr, 0);
    }
    /**
     * `[x0, y0, x1, y1]` in pixels, or empty.
     * @returns {Float32Array}
     */
    bounds() {
        const ret = wasm.vectormap_bounds(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {VectorMap}
     */
    clone() {
        const ret = wasm.vectormap_clone(this.__wbg_ptr);
        return VectorMap.__wrap(ret);
    }
    /**
     * Filled faces in pixels: `fill, ringCount, (segCount, x0, y0, (tag, cx, cy, x, y) * segCount) * ringCount`, repeated.
     * Tag 0 is a line, 1 a quadratic. Draw each face with the even-odd rule.
     * @returns {Float32Array}
     */
    contours() {
        const ret = wasm.vectormap_contours(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} ax
     * @param {number} ay
     * @param {number} bx
     * @param {number} by
     * @param {boolean} has_ctrl
     * @param {number} cx
     * @param {number} cy
     * @param {number} tx
     * @param {number} ty
     * @returns {boolean}
     */
    curveEdge(ax, ay, bx, by, has_ctrl, cx, cy, tx, ty) {
        const ret = wasm.vectormap_curveEdge(this.__wbg_ptr, ax, ay, bx, by, has_ctrl, cx, cy, tx, ty);
        return ret !== 0;
    }
    /**
     * @returns {bigint}
     */
    digest() {
        const ret = wasm.vectormap_digest(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Every edge in twips: `ax, ay, bx, by, hasCtrl, cx, cy`.
     * @returns {Int32Array}
     */
    edgeTwips() {
        const ret = wasm.vectormap_edgeTwips(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Every edge in pixels: `ax, ay, bx, by, hasCtrl, cx, cy`.
     * @returns {Float32Array}
     */
    edges() {
        const ret = wasm.vectormap_edges(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    faceAt(x, y) {
        const ret = wasm.vectormap_faceAt(this.__wbg_ptr, x, y);
        return ret >>> 0;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} fill
     * @returns {boolean}
     */
    fillAt(x, y, fill) {
        const ret = wasm.vectormap_fillAt(this.__wbg_ptr, x, y, fill);
        return ret !== 0;
    }
    /**
     * Distinct fill ids in use.
     * @returns {Uint32Array}
     */
    fills() {
        const ret = wasm.vectormap_fills(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {Uint8Array | number[]} bytes
     * @returns {VectorMap}
     */
    static fromBytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.vectormap_fromBytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return VectorMap.__wrap(ret[0]);
    }
    /**
     * @returns {boolean}
     */
    isEmpty() {
        const ret = wasm.vectormap_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Inbetween of this map (t = 0) and `other` (t = 1).
     * @param {VectorMap} other
     * @param {number} t
     * @returns {VectorMap}
     */
    lerp(other, t) {
        _assertClass(other, VectorMap);
        const ret = wasm.vectormap_lerp(this.__wbg_ptr, other.__wbg_ptr, t);
        return VectorMap.__wrap(ret);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} nx
     * @param {number} ny
     * @returns {boolean}
     */
    moveVertex(x, y, nx, ny) {
        const ret = wasm.vectormap_moveVertex(this.__wbg_ptr, x, y, nx, ny);
        return ret !== 0;
    }
    /**
     * Flat `[fromX, fromY, toX, toY, ...]` twips; one rebuild for all moves.
     * @param {Int32Array | number[]} moves
     * @returns {boolean}
     */
    moveVertices(moves) {
        const ptr0 = passArray32ToWasm0(moves, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.vectormap_moveVertices(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * `[ax, ay, bx, by, hasCtrl, cx, cy]` in twips, or empty.
     * @param {number} x
     * @param {number} y
     * @param {number} tol
     * @returns {Int32Array}
     */
    nearestEdge(x, y, tol) {
        const ret = wasm.vectormap_nearestEdge(this.__wbg_ptr, x, y, tol);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * `[x, y]` in twips, or empty.
     * @param {number} x
     * @param {number} y
     * @param {number} tol
     * @returns {Int32Array}
     */
    nearestVertex(x, y, tol) {
        const ret = wasm.vectormap_nearestVertex(this.__wbg_ptr, x, y, tol);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    constructor() {
        const ret = wasm.vectormap_new();
        this.__wbg_ptr = ret;
        VectorMapFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * `mode`: 0 over, 1 erase, 2 inside(`target`), 3 behind.
     * @param {Int32Array | number[]} rings
     * @param {number} fill
     * @param {number} mode
     * @param {number} target
     */
    paint(rings, fill, mode, target) {
        const val2 = +fill;
        const val3 = +mode;
        const val4 = +target;
        const ptr0 = passArray32ToWasm0(rings, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.vectormap_paint(this.__wbg_ptr, ptr0, len0, val2, val3, val4);
    }
    /**
     * Filled faces in twips, same layout as `contours` but as `Int32Array`
     * with tag `1` carrying the control point.
     * @returns {Int32Array}
     */
    regions() {
        const ret = wasm.vectormap_regions(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Flat `[from, to, from, to, ...]`.
     * @param {Uint32Array | number[]} pairs
     */
    remapFills(pairs) {
        const ptr0 = passArray32ToWasm0(pairs, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.vectormap_remapFills(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {number} ax
     * @param {number} ay
     * @param {number} bx
     * @param {number} by
     * @param {boolean} has_ctrl
     * @param {number} cx
     * @param {number} cy
     * @returns {boolean}
     */
    removeEdge(ax, ay, bx, by, has_ctrl, cx, cy) {
        const ret = wasm.vectormap_removeEdge(this.__wbg_ptr, ax, ay, bx, by, has_ctrl, cx, cy);
        return ret !== 0;
    }
    /**
     * `chain` is flat `[x, y, x, y, ...]` twips; `ring` is one packed ring
     * whose start is the chain's first vertex and whose segments end at its last.
     * @param {Int32Array | number[]} chain
     * @param {Int32Array | number[]} ring
     * @returns {boolean}
     */
    replaceChain(chain, ring) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray32ToWasm0(chain, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArray32ToWasm0(ring, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        const ret = wasm.vectormap_replaceChain(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret !== 0;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @returns {VectorMap}
     */
    splitOffFace(x, y) {
        const ret = wasm.vectormap_splitOffFace(this.__wbg_ptr, x, y);
        return VectorMap.__wrap(ret);
    }
    /**
     * @param {Uint32Array | number[]} fills
     * @returns {VectorMap}
     */
    splitOffFills(fills) {
        const ptr0 = passArray32ToWasm0(fills, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.vectormap_splitOffFills(this.__wbg_ptr, ptr0, len0);
        return VectorMap.__wrap(ret);
    }
    /**
     * @param {Int32Array | number[]} rings
     * @returns {VectorMap}
     */
    splitOff(rings) {
        const ptr0 = passArray32ToWasm0(rings, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.vectormap_splitOff(this.__wbg_ptr, ptr0, len0);
        return VectorMap.__wrap(ret);
    }
    /**
     * @param {VectorMap} other
     * @param {Float64Array | number[]} xf
     */
    stamp(other, xf) {
        _assertClass(other, VectorMap);
        const ptr0 = passArrayF64ToWasm0(xf, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.vectormap_stamp(this.__wbg_ptr, other.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {Uint8Array}
     */
    toBytes() {
        const ret = wasm.vectormap_toBytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * `[a, b, c, d, e, f]` with `e`, `f` in twips.
     * @param {Float64Array | number[]} xf
     */
    transform(xf) {
        const ptr0 = passArrayF64ToWasm0(xf, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.vectormap_transform(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Vertices in twips.
     * @returns {Int32Array}
     */
    vertTwips() {
        const ret = wasm.vectormap_vertTwips(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    vertexCount() {
        const ret = wasm.vectormap_vertexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Vertices in pixels: `x, y, ...`.
     * @returns {Float32Array}
     */
    verts() {
        const ret = wasm.vectormap_verts(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) VectorMap.prototype[Symbol.dispose] = VectorMap.prototype.free;

/**
 * Boolean of two packed ring sets. `op`: 0 union, 1 intersect, 2 subtract, 3 xor.
 * @param {Int32Array | number[]} a
 * @param {Int32Array | number[]} b
 * @param {number} op
 * @returns {Int32Array}
 */
export function regionOp(a, b, op) {
    const val3 = +op;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray32ToWasm0(a, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray32ToWasm0(b, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
        throw e;
    }
    const ret = wasm.regionOp(ptr0, len0, ptr1, len1, val3);
    var v4 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_208446807d0d1e30: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./kernel_bg.js": import0,
    };
}

const VectorMapFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_vectormap_free(ptr, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
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

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
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

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('kernel_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
