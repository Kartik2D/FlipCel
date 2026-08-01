/**
 * Document-facing UI state: stage artboard, symmetry, layers.
 */
import { Store } from "./store";

export interface StageSettings {
  width: number;
  height: number;
  color: string;
}

export const STAGE_SIZE_MIN = 512;
export const STAGE_SIZE_MAX = 1920;
export const STAGE_SIZE_STEP = 8;
export const DEFAULT_STAGE_WIDTH = 1280;
export const DEFAULT_STAGE_HEIGHT = 720;
export const STAGE_SIZE_PRESETS = [512, 720, 1024, 1080, 1280, 1920] as const;
export const STAGE_SIZE_SNAP_THRESHOLD = 64;

export function clampStageDimension(value: number): number {
  const clamped = Math.max(STAGE_SIZE_MIN, Math.min(STAGE_SIZE_MAX, value));
  return Math.round(clamped / STAGE_SIZE_STEP) * STAGE_SIZE_STEP;
}

/** Typed stage size: any positive integer px (no slider min/max or step grid). */
export function normalizeStageDimensionInput(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}

export function snapStageDimension(value: number): number {
  const clamped = clampStageDimension(value);
  // Prefer nearest preset within threshold so close presets (1024/1080)
  // don't steal each other via first-match order.
  let nearest: number | null = null;
  let nearestDist = Infinity;
  for (const preset of STAGE_SIZE_PRESETS) {
    const dist = Math.abs(clamped - preset);
    if (dist <= STAGE_SIZE_SNAP_THRESHOLD && dist < nearestDist) {
      nearest = preset;
      nearestDist = dist;
    }
  }
  return nearest ?? clamped;
}

export const stageStore = new Store<StageSettings>({
  width: DEFAULT_STAGE_WIDTH,
  height: DEFAULT_STAGE_HEIGHT,
  color: "#ffffff",
});

export type SymmetryMode = "vertical" | "horizontal" | "radial";

export interface SymmetrySettings {
  enabled: boolean;
  mode: SymmetryMode;
  radialCount: number;
  originX: number;
  originY: number;
}

export function normalizeSymmetrySettings(
  prefs: SymmetrySettings,
): SymmetrySettings {
  const mode: SymmetryMode =
    prefs.mode === "horizontal" || prefs.mode === "radial"
      ? prefs.mode
      : "vertical";
  return {
    enabled: !!prefs.enabled,
    mode,
    radialCount: Math.max(2, Math.min(12, Math.round(prefs.radialCount || 6))),
    originX: Number.isFinite(prefs.originX)
      ? prefs.originX
      : DEFAULT_STAGE_WIDTH / 2,
    originY: Number.isFinite(prefs.originY)
      ? prefs.originY
      : DEFAULT_STAGE_HEIGHT / 2,
  };
}

export const symmetryStore = new Store<SymmetrySettings>(
  normalizeSymmetrySettings({
    enabled: false,
    mode: "vertical",
    radialCount: 6,
    originX: DEFAULT_STAGE_WIDTH / 2,
    originY: DEFAULT_STAGE_HEIGHT / 2,
  }),
);

export const stageSelectedStore = new Store<boolean>(false);
export const STAGE_LAYER_ID = "stage";

export type LayerKind = "stage" | "regular";

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** When true, art is visible but not selectable/drawable. */
  locked: boolean;
  kind?: LayerKind;
}

export interface LayerState {
  layers: Layer[];
  activeLayerId: string;
  /** Exclusive solo: only this regular layer is shown when set. */
  soloLayerId: string | null;
}

export function generateLayerId(): string {
  return `layer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/** Whether a regular layer is shown given visibility + exclusive solo. */
export function isLayerEffectivelyVisible(
  layer: Pick<Layer, "id" | "visible" | "kind">,
  soloLayerId: string | null,
): boolean {
  if (layer.kind === "stage") return true;
  if (soloLayerId) return layer.id === soloLayerId;
  return layer.visible;
}

function createInitialLayerState(): LayerState {
  const defaultLayerId = generateLayerId();
  return {
    layers: [
      {
        id: STAGE_LAYER_ID,
        name: "Stage",
        visible: true,
        locked: false,
        kind: "stage",
      },
      {
        id: defaultLayerId,
        name: "Layer 1",
        visible: true,
        locked: false,
        kind: "regular",
      },
    ],
    activeLayerId: defaultLayerId,
    soloLayerId: null,
  };
}

export const layerStore = new Store<LayerState>(createInitialLayerState());

/** Display / download name for the open document (not part of serialized JSON). */
export const DEFAULT_DOCUMENT_NAME = "Untitled";

export const documentNameStore = new Store<string>(DEFAULT_DOCUMENT_NAME);

/** Strip a trailing `.json` (any case) for compact dock display. */
export function displayDocumentName(name: string): string {
  const trimmed = name.trim() || DEFAULT_DOCUMENT_NAME;
  return trimmed.replace(/\.json$/i, "");
}

/** Ensure a download filename ends with `.json`. */
export function downloadDocumentName(name: string): string {
  const trimmed = name.trim() || DEFAULT_DOCUMENT_NAME;
  return /\.json$/i.test(trimmed) ? trimmed : `${trimmed}.json`;
}
