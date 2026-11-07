/* tslint:disable */
/* eslint-disable */

export class VectorMap {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `[x0, y0, x1, y1]` in pixels, or empty.
     */
    bounds(): Float32Array;
    clone(): VectorMap;
    /**
     * Filled faces in pixels: `fill, ringCount, (segCount, x0, y0, (tag, cx, cy, x, y) * segCount) * ringCount`, repeated.
     * Tag 0 is a line, 1 a quadratic. Draw each face with the even-odd rule.
     */
    contours(): Float32Array;
    curveEdge(ax: number, ay: number, bx: number, by: number, has_ctrl: boolean, cx: number, cy: number, tx: number, ty: number): boolean;
    digest(): bigint;
    /**
     * Every edge in twips: `ax, ay, bx, by, hasCtrl, cx, cy`.
     */
    edgeTwips(): Int32Array;
    /**
     * Every edge in pixels: `ax, ay, bx, by, hasCtrl, cx, cy`.
     */
    edges(): Float32Array;
    faceAt(x: number, y: number): number;
    fillAt(x: number, y: number, fill: number): boolean;
    /**
     * Distinct fill ids in use.
     */
    fills(): Uint32Array;
    static fromBytes(bytes: Uint8Array | number[]): VectorMap;
    isEmpty(): boolean;
    moveVertex(x: number, y: number, nx: number, ny: number): boolean;
    /**
     * Flat `[fromX, fromY, toX, toY, ...]` twips; one rebuild for all moves.
     */
    moveVertices(moves: Int32Array | number[]): boolean;
    /**
     * `[ax, ay, bx, by, hasCtrl, cx, cy]` in twips, or empty.
     */
    nearestEdge(x: number, y: number, tol: number): Int32Array;
    /**
     * `[x, y]` in twips, or empty.
     */
    nearestVertex(x: number, y: number, tol: number): Int32Array;
    constructor();
    /**
     * `mode`: 0 over, 1 erase, 2 inside(`target`), 3 behind.
     */
    paint(rings: Int32Array | number[], fill: number, mode: number, target: number): void;
    /**
     * Filled faces in twips, same layout as `contours` but as `Int32Array`
     * with tag `1` carrying the control point.
     */
    regions(): Int32Array;
    /**
     * Flat `[from, to, from, to, ...]`.
     */
    remapFills(pairs: Uint32Array | number[]): void;
    removeEdge(ax: number, ay: number, bx: number, by: number, has_ctrl: boolean, cx: number, cy: number): boolean;
    /**
     * `chain` is flat `[x, y, x, y, ...]` twips; `ring` is one packed ring
     * whose start is the chain's first vertex and whose segments end at its last.
     */
    replaceChain(chain: Int32Array | number[], ring: Int32Array | number[]): boolean;
    splitOffFace(x: number, y: number): VectorMap;
    splitOffFills(fills: Uint32Array | number[]): VectorMap;
    splitOff(rings: Int32Array | number[]): VectorMap;
    stamp(other: VectorMap, xf: Float64Array | number[]): void;
    toBytes(): Uint8Array;
    /**
     * `[a, b, c, d, e, f]` with `e`, `f` in twips.
     */
    transform(xf: Float64Array | number[]): void;
    /**
     * Vertices in twips.
     */
    vertTwips(): Int32Array;
    vertexCount(): number;
    /**
     * Vertices in pixels: `x, y, ...`.
     */
    verts(): Float32Array;
}

/**
 * Boolean of two packed ring sets. `op`: 0 union, 1 intersect, 2 subtract, 3 xor.
 */
export function regionOp(a: Int32Array | number[], b: Int32Array | number[], op: number): Int32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_vectormap_free: (a: number, b: number) => void;
    readonly regionOp: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly vectormap_bounds: (a: number) => [number, number];
    readonly vectormap_clone: (a: number) => number;
    readonly vectormap_contours: (a: number) => [number, number];
    readonly vectormap_curveEdge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly vectormap_digest: (a: number) => bigint;
    readonly vectormap_edgeTwips: (a: number) => [number, number];
    readonly vectormap_edges: (a: number) => [number, number];
    readonly vectormap_faceAt: (a: number, b: number, c: number) => number;
    readonly vectormap_fillAt: (a: number, b: number, c: number, d: number) => number;
    readonly vectormap_fills: (a: number) => [number, number];
    readonly vectormap_fromBytes: (a: number, b: number) => [number, number, number];
    readonly vectormap_isEmpty: (a: number) => number;
    readonly vectormap_moveVertex: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly vectormap_moveVertices: (a: number, b: number, c: number) => number;
    readonly vectormap_nearestEdge: (a: number, b: number, c: number, d: number) => [number, number];
    readonly vectormap_nearestVertex: (a: number, b: number, c: number, d: number) => [number, number];
    readonly vectormap_new: () => number;
    readonly vectormap_paint: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly vectormap_regions: (a: number) => [number, number];
    readonly vectormap_remapFills: (a: number, b: number, c: number) => void;
    readonly vectormap_removeEdge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly vectormap_replaceChain: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly vectormap_splitOff: (a: number, b: number, c: number) => number;
    readonly vectormap_splitOffFace: (a: number, b: number, c: number) => number;
    readonly vectormap_splitOffFills: (a: number, b: number, c: number) => number;
    readonly vectormap_stamp: (a: number, b: number, c: number, d: number) => void;
    readonly vectormap_toBytes: (a: number) => [number, number];
    readonly vectormap_transform: (a: number, b: number, c: number) => void;
    readonly vectormap_vertTwips: (a: number) => [number, number];
    readonly vectormap_vertexCount: (a: number) => number;
    readonly vectormap_verts: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
