# Flash-style Symbols — Implementation Plan

Status: planning. Decisions below were confirmed on 2026‑10‑23.

## 1. Decisions

Confirmed by you:

| Topic | Decision |
|---|---|
| Instance placement | Instances are **objects on vector layers**, coexisting with merge-drawing shapes (true Flash). |
| Symbol content | A **nested timeline**: own layers, keyframes, holds, tags. Shares the document content map. |
| Playback | Graphic-symbol modes **Loop / Play Once / Single Frame** + `firstFrame`, all keyable. |
| Editing | **Edit in place**: parent frame dimmed behind, inverse-transformed into the symbol's local space; breadcrumb to exit. |
| Browsing | New dockable **Library panel** (thumbnails, rename, duplicate, delete, edit, place). |
| Creation | **One tap, auto-named** "Symbol N". Sources: stage selection, or a timeline frame-range selection. |
| Pivot | Symbol origin = bounds center at convert time; each instance has a **movable pivot** on the gizmo. |
| v1 integrations | **Swap Symbol** + export flattening (SVG/Godot). Everything else is phase 2 (see §12). |

Decisions I'm making (push back if any are wrong):

1. **Instances always render above the shapes on their layer** (Flash rule). Z-order among instances is kept; shapes keep their planar partition underneath. Want an instance *behind* a shape → use layers. This avoids every stroke reordering instances vs. shapes.
2. **No Movie Clip / Button types.** FlipCel exports frames; only Graphic symbols make sense.
3. **Nested symbols are not creatable in v1** (Convert to Symbol is unavailable when the selection contains an instance; Place is unavailable inside a symbol). The renderer is still written recursively with depth + cycle guards so phase 2 is a UI unlock, not a rewrite.
4. **Selecting an instance uses the same gesture as shapes** (hold / double-tap). Entering a symbol = double-tap an *already selected* instance, or "Edit Symbol" in contextual actions. Keeps the select tool's "drag = marquee" rule intact.
5. **Symbol tracks are vector-only in v1** (no image/audio tracks inside symbols).
6. **Edit from the Library** = enter the symbol with no backdrop (isolated); edit from stage = in place. Same code path, backdrop optional.
7. **Undo/redo crosses contexts**: history entries record the edit-context path and restoring an entry re-enters/leaves symbols as needed. Entering/exiting a symbol itself is not a history entry.
8. **Document format bumps to `version: 3`**, additive (`symbols` record). v1/v2 docs load with no symbols.

## 2. Why this is invasive here, and the containment strategy

Every vector layer is a flat planar partition of `Path`/`CompoundPath` (see header of `src/render/paper/paper-renderer.ts`). `flattenGroups()` (`src/render/paper/svg-io.ts`) is called ~15× in the renderer and in the merge kernel/worker; selection is typed `paper.PathItem[]`; merge/fill/magnet/direct-select/EMF all filter for path items.

Containment strategy — an instance is a **`paper.Group` with `applyMatrix = false`, no persisted children, and a flat `data` record**:

- It is **not a PathItem**, so every existing `instanceof Path || CompoundPath` filter (merge kernel neighbors, fill, magnet, direct-select, EMF path lists) ignores it with zero changes.
- It is **native Paper JSON**, so it round-trips through *every* `importJSON`/`exportJSON` site unchanged (worker, onion skin, export scopes, Magic Move JSON helpers) as a harmless empty group carrying `matrix`, `pivot`, `data`.
- `Item.matrix` + `Item.pivot` are serialized natively (`_serializeFields` in paper-core: `applyMatrix, matrix, pivot, data`). Setting `group.pivot` makes `group.position` *be* the pivot in parent coords, so the existing gizmo rotation-pivot code (`getRotatePivotWorld` → `item.position`) works unchanged.
- Resolved artwork is **hydrated** into the group as children only in live/visual contexts and **stripped** before any export. Exported layer JSON is therefore deterministic and small, so `layerJsonEquals` dirty detection does not produce phantom keyframes.
- `Item.clone()` shallow-copies `data` (`Base.clone`), so the record is **flat primitives only**; the `iid` is reassigned on duplicate.

The two deliberate exceptions to "no kernel changes":
- `flattenGroups()` gets one guard: skip groups where `isSymbolInstance(child)`. Shared by main thread and worker.
- A `normalizeInstanceOrder(layer)` call (instances to the end, relative order kept) after merge passes. Pure, cheap.

## 3. Data model (`src/document/document.ts`)

```ts
export type SymbolPlayMode = "loop" | "once" | "single";

export interface SymbolDefinition {
  id: string;            // `sym${base36}-${n}`
  name: string;
  tracks: LayerTrack[];  // bottom → top; vector only in v1
  duration: number;
  tags: FrameTag[];      // symbol-local; later used as names in the first-frame picker
}

/** Lives in layer content JSON as `data` of an empty Group (applyMatrix=false). Flat primitives only. */
export interface SymbolInstanceData {
  symbol: string;        // SymbolDefinition.id
  iid: string;           // stable instance identity across frames / merge rebuilds / undo
  mode: SymbolPlayMode;
  firstFrame: number;    // 0-based child frame shown at the covering keyframe's start
}
// Transform: Group.matrix. Pivot: Group.pivot (local coords). Both serialized natively.

export interface SerializedDocument {
  version: 1 | 2 | 3;
  // ...existing...
  symbols?: Record<string, SymbolDefinition>;   // content ids point into the shared `content` map
}

export interface DocumentState {               // history entry payload
  root: { tracks; duration; tags; currentFrame };
  symbols: Record<string, SymbolDefinition>;   // tracks cloned, content shared by ref
  context: EditContextRef[];                   // see §6
  frameRate: number;
}
```

Frame math (pure, unit-tested):

```
elapsed    = parentFrame − coveringKeyframe.frameIndex          (≥ 0)
childFrame = single: clamp(firstFrame, 0, D−1)
             loop:   (firstFrame + elapsed) mod D
             once:   min(firstFrame + elapsed, D−1)
```

Consequence: a hold span containing a loop/once instance is **no longer free on scrub**. `reloadCurrentFrame` must re-hydrate instance groups on layers whose content id did not change but which contain animated instances (swap the instance children only; shapes stay).

## 4. New module: `src/render/paper/symbol-instances.ts`

Pure helpers, usable in any PaperScope (take `scope` explicitly, default `paper`) and in the worker.

- `isSymbolInstance(item): item is paper.Group`, `readInstance(group): SymbolInstanceData`, `newIid()`.
- `createInstance(scope, data, worldPoint): paper.Group` — `applyMatrix=false`, `pivot=(0,0)` local, `position=worldPoint`.
- `SymbolResolver` interface `{ getSymbol(id), getContent(contentId) }` — implemented by `DocumentManager`.
- `resolveSymbolFrameJsons(symbolId, childFrame, resolver): Array<{ json, keyframeFrame }>` — visible tracks bottom→top using the covering-keyframe rule. Requires moving `previousKeyframe` / `coveringKeyframe` / `contentIdAt` out of `DocumentManager` into exported pure functions (same file, no behavior change).
- `childFrameFor(data, elapsed, duration)` — the §3 math.
- `hydrateInstance(group, resolver, elapsed, scope, depth=0, visiting=Set)` — remove children, import each resolved json into a scratch layer, recurse into nested instances with their own elapsed, move children into the group. Depth cap 8 + cycle guard. Missing symbol → render nothing (console.warn once).
- `hydrateLayer(layer, resolver, elapsed, scope)`.
- `withInstancesStripped(layer, fn)` — detach children of every instance group, run `fn`, reattach. Used around every export.
- `normalizeInstanceOrder(layer)`.
- `withInstancesHidden(layers, fn)` — for the fill tool raster.
- `scanInstanceSymbolIds(json): string[]` — regex over the JSON string (`"symbol":"sym…"`), cached per content id for usage counts.
- `TemplateCache` — parsed template `Group` per content id, `clone()` per hydration (playback perf). Cleared on load / applyState / recolor / rename rewrite.

Node fixture `symbol-instances.check.ts` (same style as `merge-layer.check.ts`, `npm run check:symbols`): strip/hydrate round trip is byte-identical; `flattenGroups` keeps instances; `mergeJsons` of two layers keeps both layers' instances above shapes in the right order; frame math table; cycle guard terminates.

## 5. Renderer touch points (`src/render/paper/paper-renderer.ts`)

| Site | Change |
|---|---|
| `exportLayerJSON` (~618) | wrap in `withInstancesStripped`. Also strips the worker's `getBaseJson`. |
| `exportLayerContentsByKeyframe` (~237, direct `layer.exportJSON()`) | strip. |
| `importLayerContent` (~696) | after `importJSON`, `hydrateLayer(layer, resolver, elapsed)`. Renderer keeps `elapsedByLayer: Map<layerId, number>` set by the document on every load. |
| `setLayerContentsByKeyframe` (EMF, ~183) | hydrate each bucket with `elapsed = playhead − bucketFrame` if the playhead is inside that keyframe's span, else 0. |
| `applyMergeResult` (~1017) | **preserve instance identity**: before `removeChildren()`, detach instance groups by `iid`; after `importJSON`, `replaceWith` the originals (copy matrix/data from the imported stub), re-hydrate, `normalizeInstanceOrder`. Selection references survive worker rebuilds. |
| `mergeAddInto` / `mergeSubtractInto` / paint-inside / `pasteJsonOntoActiveLayer` | `normalizeInstanceOrder(layer)` after the pass. |
| `hitTestSelectable` (~1542) | walk the hit up to the layer's root child; return the instance group when the root is an instance. |
| `extractSelectionFromPath` (~2021) | add a second pass: instance groups whose bounds intersect `selectionPath.bounds` are selected whole (no boolean cutting). Marker for instances = `iid`. |
| `flipItemsInViewSpace`, `deleteItem`, `getLayerIdForPathItem`, `setItemFillColor` | widen to `paper.Item`; `setItemFillColor` no-ops on instances (tint is phase 2). |
| `rehydrateAnimatedInstances(layerId, elapsed)` | new; swaps instance children only (hold-scrub hot path). |
| `setSymbolResolver(resolver)` | new, mirrors `setImageResolver`. |
| `svg-io.ts flattenGroups` | skip `isSymbolInstance`. |
| `merge-layer.ts mergeJsons` | `normalizeInstanceOrder` before export (runs in the worker too). |

Other visual contexts that import stored JSON and must hydrate (all need `elapsed` → use `doc.getCoveringKeyframeFrame(layerId, frame)`, which already exists):
- `src/export/svg-export.ts` (~131) and `src/export/godot-sprite-export.ts` (~195): hydrate with the export scope.
- `src/render/paper/onion-skin.ts`: v1 may leave instances invisible in ghosts (they import as empty groups). Hydrating is ~5 lines once the helper exists — optional in M5.
- `magic-morph-blend.ts`, Magic Move JSON helpers: operate on root children; empty groups are harmless. Both tools filter instances out of their selections in v1.

## 6. DocumentManager changes (`src/document/document.ts`)

**Symbol store**: `private symbols = new Map<string, SymbolDefinition>()`; `symbolIdCounter`; CRUD: `createSymbol`, `renameSymbol`, `duplicateSymbol`, `deleteSymbol` (v1: only when usage count is 0), `getSymbol`, `listSymbols`.

**Edit context (edit in place)** — swap approach, minimal diff: `tracks/duration/tags/currentFrame/emf*` stay as fields; entering a symbol saves them into a stack entry and loads the symbol's; exiting restores. `frameRate` is global.

```ts
interface EditContextRef { symbolId; instanceIid: string | null; layerId: string | null; parentFrame: number; worldMatrix: [a,b,c,d,tx,ty] | null }
enterSymbol(symbolId, via?: { layerId; iid })   // via = in place; omitted = isolated (from Library)
exitSymbol(); exitToRoot(); getContextPath()
private flushActiveTimeline()                    // write live tracks/duration/tags back into the symbol record (or root holder)
```

- Enter: commit dirty, `flushActiveTimeline`, push, load symbol timeline, `currentFrame = childFrame currently displayed by the instance`, `loadedContent.clear()`, `updateLayerStoreFromTracks`, `reloadCurrentFrame`, build backdrop (§8), publish `editContextStore` `{ path: [{symbolId, name}], inPlace }`.
- Exit: commit, flush, pop, restore, clear backdrop, reload, reselect the instance by `iid`.
- `flushActiveTimeline()` is also called at the top of `captureState`, `serialize`, and before any `SymbolResolver.getSymbol` read, so hydration always sees live edits.
- Restrictions while inside a symbol (enforced in the UI via `editContextStore`): no image/audio layer add; no Place; no Convert to Symbol.
- `setFrameRate` with real-time lock → `retimeTracks`/`retimeTags` over **root + every symbol** (`retimeAll`). `setDuration` affects the active timeline only.

**History** (`src/document/history.ts`): `captureState()` → `{ root, symbols, context, frameRate }`; `applyState()` → restore symbols + root, then replay the context path (re-enter with backdrop). `gcContent` (doc + history) walks symbol keyframes too.

**Serialization**: `serialize()` flushes, writes `version: 3`, `symbols`, and content for root + symbol keyframes. `loadSerialized()` normalizes symbols with the same invariants as tracks (sort, hold clamp against the *symbol's* duration, vector kind). `src/document/persistence.ts parseSerializedDocument` accepts v3 and validates `symbols` shape; `normalizeTrack` reused.

**Reload path**: `reloadCurrentFrame` passes `elapsed` per layer to the renderer (`setLayerElapsed` before `restoreLayersSnapshot`); for layers with unchanged content ids but animated instances, call `rehydrateAnimatedInstances`. Track `animatedInstanceLayers: Set<layerId>` from the last hydration.

**Publishing**: `publish()` also sets `symbolLibraryStore` `{ symbols: [{ id, name, duration, usageCount }] }`. Usage count via `scanInstanceSymbolIds` with a per-content-id cache. `collectDocumentColors` and `recolorDocument` walk symbol contents too (document-wide recolor includes symbols).

**Operations**:
- `placeSymbolInstance(symbolId, worldPoint)` → group on the active vector layer, hydrate, mark dirty, `commitActiveLayerContent` (auto-keys on holds), returns the group.
- `convertSelectionToSymbol(items)` (§9).
- `convertFrameRangeToSymbol(layerIds, start, end, anchorLayerId)` (§9).
- `swapInstanceSymbol(group, symbolId)` → set `data.symbol`, clamp `firstFrame`, re-hydrate, commit.
- `setInstancePlayback(group, patch)` → mode/firstFrame, re-hydrate, commit.

## 7. Selection & transform

- `selectionStore.items: paper.Item[]` (`src/state/drawing.ts`). TypeScript will flag every consumer (~15 files). Add `pathItemsOf(items)` and `instancesOf(items)` helpers; consumers that are path-only (direct-select, magnet, Magic Move, Magic Morph, `setSelectionClipboardFromItems`, `simplify` etc.) filter with `pathItemsOf`. Contextual-action availability (`src/editing/contextual-actions.ts`) uses the filtered lists.
- `SelectionController` (`src/editing/object-select.ts`): `selectedItems: paper.Item[]`. Move/scale/rotate already call `item.translate/scale/rotate` via renderer helpers that accept `paper.Item` — instance transforms accumulate in `group.matrix` because `applyMatrix=false`. Mixed selections work; instances skip the re-merge step (`pendingExtractionSnapshot` logic applies to paths only).
- Gizmo pivot (`src/editing/transform-gizmo.ts`, `src/render/paper/selection-chrome.ts`): when exactly one instance is selected, draw a pivot handle at `item.position`; dragging it sets `group.pivot = group.matrix.inverseTransform(world)` (does not move art). Rotation pivot code path already uses `item.position`. Pivot is part of the layer JSON, so it is keyable like everything else.
- Double-tap on an already selected instance → `onEnterSymbol(group)` callback (wired in `src/app/tool-session.ts` / `bootstrap.ts`).
- Duplicate (contextual action, in-frame) → `clone()` + `data.iid = newIid()`; no merge needed.
- Copy (contextual action) filters instances out in v1; cross-frame paste of instances is phase 2 (it's strip + hydrate + new iid, small).
- Fill tool: wrap rasterization (`getFillRasterLayers` callers in `src/editing/fill-region.ts` / `fill-pocket.ts`) in `withInstancesHidden` so fills ignore objects (Flash semantics).

## 8. Edit-in-place rendering

New `src/render/paper/context-backdrop.ts` modeled on `OnionSkin` (locked ghost layers not in `layerMap`):

- Input: parent timeline snapshot at `parentFrame`, the entered instance's `iid`, its `worldMatrix`.
- Builds two ghost groups: **below** (parent layers under the instance's layer + that layer's shapes + instances ordered before it) and **above** (instances after it + layers above). Both hydrated via the resolver (other instances animate correctly), dimmed with per-item opacity (same perf reasoning as onion skin), and transformed by `worldMatrix.inverted()` so the edited symbol sits in its own local space. Image layers included as rasters.
- `StageLayer` (`src/render/stage-layer.ts`) gets `setLocalTransform(matrix | null)`: one extra `ctx.transform(...)` so the artboard fill is drawn in the symbol's local space too (rotated/scaled instance → rotated/scaled artboard, like Flash).
- Rebuilt when the parent frame would change (it can't while inside; only on enter/undo-restore).
- Top bar (`src/ui/panels/top-bar.ts`): breadcrumb `Scene › Symbol 2` from `editContextStore`; tap a crumb to exit to it. `Esc` exits one level when no gesture/popup is active (`src/input/shortcuts.ts`). Layers panel title shows the symbol name while inside.

## 9. Creation flows

**Convert to Symbol — stage selection** (`contextual-actions.ts` "To Symbol", `F8`):
1. Items = selected root items; unavailable if any is an instance (v1) or selection is empty.
2. `origin` = combined bounds center (world).
3. Clone items into a scratch layer, strip `emfKeyframeFrame`, translate by `−origin`, `exportItemsJson` → content id. Symbol: one track "Layer 1", keyframe 0, `duration 1`.
4. Delete source items; add one instance at `origin` (identity matrix, pivot (0,0)) on the active layer if it is a selectable vector layer, else the topmost source layer. Hydrate, mark dirty, `commitLayersContent`, select the instance, snapshot "Convert to Symbol".

**Convert to Symbol — frame range** (frame-actions popover in `src/ui/panels/layers-panel.ts renderFrameActionsPopover`, "To Symbol"):
1. From `LayersFrameSelection { start, end, layerIds, anchorLayerId }`; vector layers only; unavailable inside a symbol (v1).
2. For each layer: `extractFrameRange` (clip + materialize holds), rebase by `−start` → symbol tracks (same names, fresh ids). Symbol `duration = end − start + 1`. Copy document tags fully inside the range, rebased.
3. `origin` = union bounds center over all unique contents in the range (offscreen measure). Translate each unique content by `−origin` into new content ids (never mutate shared content).
4. `cutFrameRange` on all source layers. On `anchorLayerId`, place a keyframe at `start` holding to `end` whose content is a layer JSON with exactly one instance `{ mode: "loop", firstFrame: 0 }` at `origin`.
5. Reload, publish, snapshot "Convert Frames to Symbol".

**Library panel** (`src/ui/panels/library-panel.ts`, registered in `index.html`, `ui/register.ts`, `top-bar.ts` panel list, `panel-bridge.ts`, `bootstrap.ts`, `help/catalog.ts`):
- Rows: thumbnail, name (inline rename like layer rename), duration, usage count. Actions: Place, Edit, Duplicate, Delete (disabled with count when used).
- Thumbnails: `SymbolThumbnailCache` renders the first non-blank frame offscreen (same scope pattern as `svg-export.ts`) to a ~96px canvas → data URL, keyed by the frame's content ids, computed in `requestIdleCallback`.
- Place: world point = viewport center; switches to the select tool and selects the new instance (touch-friendly). Disabled when the active layer is not an unlocked vector layer or inside a symbol.

**Instance popup** (`src/ui/panels/symbol-instance-popup.ts`, pattern: `auto-morph-popup.ts` / tag-actions popover), opened from contextual action "Symbol…" when exactly one instance is selected: symbol name (tap → Swap list), mode segmented control, first-frame stepper (shows tag names when the symbol has tags), Edit Symbol, Reset Pivot. Edits go through `setInstancePlayback` → commit → snapshot.

## 10. Export flattening

`svg-export.ts` and `godot-sprite-export.ts`: after `layer.importJSON(json)`, `hydrateLayer(layer, resolver, frame − doc.getCoveringKeyframeFrame(layerId, frame), scope)`. Nested instances resolve recursively. JSON/JS document export keeps symbols (it is `serialize()`).

## 11. "Must not break" matrix

| Feature | Behavior with instances present |
|---|---|
| Brush / lasso / shape / fill / text / create-points | Kernel ignores instances; new shapes land below instances (`normalizeInstanceOrder`). Fill rasterizes with instances hidden. |
| Select move/scale/rotate/flip/delete/duplicate | Works on instances and mixed selections (§7). |
| Direct select, magnet | Paths only; instances filtered out. |
| Magic Move / Magic Morph / Auto Morph | Paths only in v1; instances ignored. Both work *inside* a symbol's timeline unchanged. |
| EMF | Buckets include instances; moves write back per keyframe. |
| Holds / auto-key / scrub | Export is stripped → no phantom keys. Animated instances re-hydrate per frame within holds. |
| Merge Layer Down | Worker `mergeJsons` keeps both layers' instances above shapes, below-layer instances first. |
| Onion skin | Instances invisible in ghosts (v1) or hydrated (optional M5). |
| Document recolor / palette | Includes symbol contents. Instance `setItemFillColor` is a no-op. |
| Undo/redo | Captures symbols + context; crosses contexts. |
| Autosave / load | v3 additive; old docs load. |
| Image / audio layers | Unchanged; not allowed inside symbols. |
| Symmetry, snapping, quick shape | Unaffected (stroke-time features). Snapping sources use bounds → instances contribute bounds naturally. |
| Playback | Instances animate; template cache keeps per-frame cost to clone + matrix. |

## 12. Milestones

Each milestone ends with `npm run build` (tsc + vite) green and the node fixtures passing. No browser automation (per your rule); you smoke-test manually.

**M0 — Foundations (no UI)**
- Types (§3), pure keyframe helpers extracted, `symbol-instances.ts` (§4) + `check:symbols` fixture.
- `flattenGroups` guard; strip/hydrate at the renderer boundaries; `applyMergeResult` identity preservation; `normalizeInstanceOrder` in kernel wrappers and `mergeJsons`.
- `DocumentManager`: symbol store, resolver, `flushActiveTimeline`, `elapsed` on load, animated re-hydrate on scrub, serialization v3 + persistence, history capture/GC incl. symbols.
- Exit criteria: a hand-written v3 JSON fixture with one looping symbol renders and scrubs; save → reload is byte-stable; strokes drawn on the layer leave the instance intact and above.

**M1 — Select & transform instances**
- `selectionStore.items: paper.Item[]` refactor + `pathItemsOf` filters everywhere TypeScript flags.
- Hit-test / marquee inclusion, gizmo on instances, pivot handle, duplicate (new iid), delete, Copy filter, fill `withInstancesHidden`.

**M2 — Create & browse**
- Convert to Symbol (selection) + `F8`; Library panel + store + usage counts + thumbnails; Place; rename/duplicate/delete-unused; help entries.

**M3 — Edit in place**
- Context stack, backdrop, stage local transform, breadcrumb + Esc, layers-panel restrictions, history context restore, `retimeAll`.

**M4 — Playback & instance properties**
- Instance popup (mode / first frame / swap / edit / reset pivot), `setInstancePlayback`, Swap Symbol, template cache, loop/once/single verified across holds and EMF.

**M5 — Frame-range convert, export, polish**
- Frame-range "To Symbol" in the frame-actions popover; SVG/Godot hydration; optional onion-skin hydration; shortcuts; help catalog; README feature line.

**Phase 2 (explicitly out of v1)**: nested symbols (UI unlock), Break Apart, Magic Move on instances (bake `matrix` per keyframe — the motion-tween replacement; `iid` already identifies the instance across frames), cross-frame clipboard, alpha/tint, flip on instances, drag-from-library, child-frame ticks on parent timeline rows, delete-with-usages, image tracks inside symbols, 9-point registration, library search/folders.

## 13. Risks

- **Selection type widening** is the biggest mechanical change; do it in one pass with the compiler as the checklist, not incrementally.
- **Per-frame hydration cost** during playback with many/complex instances → template cache from the start; measure before adding anything fancier.
- **Identity through worker rebuilds** (`applyMergeResult`) must be right or instance selection flickers during mixed moves; covered by the `iid` replace-with step and a fixture.
- **Context stack + history**: keep `flushActiveTimeline` the single sync point; every read of symbol timelines goes through it.
- **Inverse-transformed backdrop** with non-uniform scale shows a skewed parent — correct (Flash does the same), but worth a note in the help text.
