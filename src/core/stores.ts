/**
 * Reactive Store System
 *
 * Provides a minimal observable store pattern for centralized state management.
 * Components subscribe to stores and automatically receive updates when state changes.
 *
 * This eliminates manual state synchronization between components.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { CanvasConfig, Modifiers } from "./types";
import { type ToolId, type AllToolSettings, buildDefaultSettings } from "./tools";
import { type ColorSpaceId, getColorSpaceAdapter } from "../ui/color-utils";

type Listener<T> = (value: T) => void;

/**
 * Generic reactive store with subscribe/publish pattern
 */
export class Store<T> {
  private value: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.value = initial;
  }

  /**
   * Get current value
   */
  get(): T {
    return this.value;
  }

  /**
   * Set new value and notify all subscribers
   */
  set(value: T) {
    this.value = value;
    this.listeners.forEach((fn) => fn(value));
  }

  /**
   * Update value using a function (for immutable updates)
   */
  update(fn: (current: T) => T) {
    this.set(fn(this.value));
  }

  /**
   * Subscribe to value changes
   * @returns Unsubscribe function
   */
  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Subscribe and immediately call with current value
   * @returns Unsubscribe function
   */
  subscribeImmediate(fn: Listener<T>): () => void {
    fn(this.value);
    return this.subscribe(fn);
  }
}

// ============================================================
// StoreController for Lit Components
// ============================================================

/**
 * Reactive controller that auto-subscribes Lit components to stores.
 * Handles lifecycle (connect/disconnect) and triggers re-renders on updates.
 *
 * Usage:
 *   private tool = new StoreController(this, toolStore);
 *   // Access via this.tool.value in render()
 *   // Set via this.tool.set(newValue)
 */
export class StoreController<T> implements ReactiveController {
  private host: ReactiveControllerHost;
  private store: Store<T>;
  private unsubscribe?: () => void;

  value: T;

  constructor(host: ReactiveControllerHost, store: Store<T>) {
    this.host = host;
    this.store = store;
    this.value = store.get();
    host.addController(this);
  }

  hostConnected() {
    this.unsubscribe = this.store.subscribe((value) => {
      this.value = value;
      this.host.requestUpdate();
    });
  }

  hostDisconnected() {
    this.unsubscribe?.();
  }

  get(): T {
    return this.value;
  }

  set(value: T) {
    this.store.set(value);
  }

  update(fn: (current: T) => T) {
    this.store.update(fn);
  }
}

// ============================================================
// App-Wide Singleton Stores
// ============================================================

/**
 * Current brush/drawing color (hex string)
 */
export const colorStore = new Store<string>("#037ffc");

/**
 * Previous color (before last committed change)
 * Updated when user finishes a color pick (mouseup/touchend)
 */
export const prevColorStore = new Store<string>("#000000");

// ============================================================
// Color Panel UI Preferences
// ============================================================

export type PickerGeometry = "square" | "circle";

export interface ColorPanelPrefs {
  space: ColorSpaceId;
  geometry: PickerGeometry;
  planeX: string;
  planeY: string;
}

export function normalizeColorPanelPrefs(prefs: ColorPanelPrefs): ColorPanelPrefs {
  const adapter = getColorSpaceAdapter(prefs.space);
  const ids = new Set(adapter.channels.map((c) => c.id));

  let { planeX, planeY } = prefs;
  if (!ids.has(planeX) || !ids.has(planeY) || planeX === planeY) {
    planeX = adapter.defaultPlaneX;
    planeY = adapter.defaultPlaneY;
  }

  return {
    space: prefs.space,
    geometry: prefs.geometry === "circle" ? "circle" : "square",
    planeX,
    planeY,
  };
}

export function colorPanelPrefsForSpace(
  space: ColorSpaceId,
  geometry: PickerGeometry,
): ColorPanelPrefs {
  const adapter = getColorSpaceAdapter(space);
  return normalizeColorPanelPrefs({
    space,
    geometry,
    planeX: adapter.defaultPlaneX,
    planeY: adapter.defaultPlaneY,
  });
}

export const colorPanelPrefsStore = new Store<ColorPanelPrefs>(
  normalizeColorPanelPrefs({
    space: "hsv",
    geometry: "square",
    planeX: "s",
    planeY: "v",
  })
);

/**
 * Current active tool
 */
export const toolStore = new Store<ToolId>("brush");

/**
 * Previous tool (before last switch). Used for tool-swap shortcut.
 */
export const prevToolStore = new Store<ToolId>("select");

/**
 * View overlay preferences (grid, etc.) — Settings panel + UI canvas
 */
export interface ViewOverlaySettings {
  /** When false, the world grid overlay is hidden. */
  gridEnabled: boolean;
  /** When true, onion-skin ghosts render as tinted outlines; when false, filled. */
  onionSkinOutline: boolean;
  /** World-space distance between grid lines. */
  gridSpacing: number;
  /** Every Nth line is drawn stronger. */
  gridMajorEvery: number;
  /** Minor grid line opacity (0–1). */
  gridMinorOpacity: number;
  /** Major grid line opacity (0–1). */
  gridMajorOpacity: number;
}

export function normalizeViewOverlaySettings(
  prefs: ViewOverlaySettings,
): ViewOverlaySettings {
  return {
    gridEnabled: prefs.gridEnabled,
    onionSkinOutline: prefs.onionSkinOutline,
    gridSpacing: Math.max(10, Math.min(500, Math.round(prefs.gridSpacing || 100))),
    gridMajorEvery: Math.max(2, Math.min(20, Math.round(prefs.gridMajorEvery || 5))),
    gridMinorOpacity: Math.max(0, Math.min(1, prefs.gridMinorOpacity ?? 0.06)),
    gridMajorOpacity: Math.max(0, Math.min(1, prefs.gridMajorOpacity ?? 0.14)),
  };
}

export const viewOverlayStore = new Store<ViewOverlaySettings>(
  normalizeViewOverlaySettings({
    gridEnabled: true,
    onionSkinOutline: false,
    gridSpacing: 100,
    gridMajorEvery: 5,
    gridMinorOpacity: 0.06,
    gridMajorOpacity: 0.14,
  }),
);

// ============================================================
// Stage (background rect under vector art)
// ============================================================

export interface StageSettings {
  width: number;
  height: number;
  color: string;
}

/** Vector-friendly artboard bounds — avoid tiny sketches or 4K+ extremes. */
export const STAGE_SIZE_MIN = 512;
export const STAGE_SIZE_MAX = 1920;
export const STAGE_SIZE_STEP = 8;
export const DEFAULT_STAGE_WIDTH = 1280;
export const DEFAULT_STAGE_HEIGHT = 720;

/** Common artboard sizes shown as slider notches (within min/max, step-aligned). */
export const STAGE_SIZE_PRESETS = [512, 720, 1024, 1280, 1920] as const;

/** Pull slider values toward a preset when within this distance (px). */
export const STAGE_SIZE_SNAP_THRESHOLD = 64;

export function clampStageDimension(value: number): number {
  const clamped = Math.max(STAGE_SIZE_MIN, Math.min(STAGE_SIZE_MAX, value));
  return Math.round(clamped / STAGE_SIZE_STEP) * STAGE_SIZE_STEP;
}

export function snapStageDimension(value: number): number {
  const clamped = clampStageDimension(value);
  for (const preset of STAGE_SIZE_PRESETS) {
    if (Math.abs(clamped - preset) <= STAGE_SIZE_SNAP_THRESHOLD) {
      return preset;
    }
  }
  return clamped;
}

export const stageStore = new Store<StageSettings>({
  width: DEFAULT_STAGE_WIDTH,
  height: DEFAULT_STAGE_HEIGHT,
  color: "#ffffff",
});

/**
 * Unique colors used across the document (stage fill + all keyframe artwork).
 */
export const documentColorsStore = new Store<string[]>([]);

/** True when the Stage row is selected in the layer panel (color panel edits stage fill). */
export const stageSelectedStore = new Store<boolean>(false);

/** Logical layer id for the non-Paper stage row (bottom of stack, immovable). */
export const STAGE_LAYER_ID = "stage";

// ============================================================
// Theme
// ============================================================

export type ThemeMode = "light" | "dark";

export const themeModeStore = new Store<ThemeMode>("dark");

// ============================================================
// Animation wheel
// ============================================================

/** Jog-wheel coast friction preset (Settings panel). */
export type WheelFriction = "low" | "medium" | "high";

export const WHEEL_FRICTION_OPTIONS: readonly WheelFriction[] = [
  "low",
  "medium",
  "high",
];

/** Per-preset coast + snap-settle motion for the jog wheel. */
export interface WheelFrictionMotion {
  /** Exponential friction tau (ms) while coasting; higher = longer coast. */
  tauMs: number;
  /** Barrel overshoot settle duration when pegging to a chamber. */
  settleDurationMs: number;
  /** Barrel overshoot settle easing. */
  settleEasing: string;
}

export const WHEEL_FRICTION_MOTION: Record<WheelFriction, WheelFrictionMotion> = {
  low: {
    tauMs: 300,
    settleDurationMs: 520,
    settleEasing: "cubic-bezier(0.175, 0.885, 0.32, 1.85)",
  },
  medium: {
    tauMs: 90,
    settleDurationMs: 350,
    settleEasing: "cubic-bezier(0.175, 0.885, 0.32, 1.6)",
  },
  high: {
    tauMs: 25,
    settleDurationMs: 220,
    settleEasing: "cubic-bezier(0.25, 0.9, 0.35, 1.25)",
  },
};

export function wheelFrictionMotion(level: WheelFriction): WheelFrictionMotion {
  return WHEEL_FRICTION_MOTION[level];
}

export function wheelFrictionTauMs(level: WheelFriction): number {
  return WHEEL_FRICTION_MOTION[level].tauMs;
}

export const wheelFrictionStore = new Store<WheelFriction>("medium");

/**
 * Canvas configuration (dimensions)
 * Initialized with placeholder values - App.ts sets real values on init
 */
export const configStore = new Store<CanvasConfig>({
  pixelWidth: 0,
  pixelHeight: 0,
  viewportWidth: 0,
  viewportHeight: 0,
});

/**
 * Keyboard modifier keys state
 */
export const modifiersStore = new Store<Modifiers>({
  shift: false,
  alt: false,
  ctrl: false,
  meta: false,
});

/**
 * Per-tool settings - defaults derived from tool registry
 */
export const toolSettingsStore = new Store<AllToolSettings>(
  buildDefaultSettings() as AllToolSettings
);

// ============================================================
// Selection Store
// ============================================================

export interface SelectionState {
  items: paper.PathItem[];
}

export const selectionStore = new Store<SelectionState>({
  items: [],
});

// ============================================================
// Layer Store
// ============================================================

/**
 * Layer definition
 */
export type LayerKind = "stage" | "regular";

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** Stage is UI-only; no Paper.js layer. Omitted means regular. */
  kind?: LayerKind;
}

/**
 * Layer state containing all layers and the active layer ID
 */
export interface LayerState {
  layers: Layer[];
  activeLayerId: string;
}

/**
 * Generate a unique layer ID
 */
export function generateLayerId(): string {
  return `layer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create the default initial layer
 */
function createInitialLayerState(): LayerState {
  const defaultLayerId = generateLayerId();
  return {
    layers: [
      { id: STAGE_LAYER_ID, name: "Stage", visible: true, kind: "stage" },
      { id: defaultLayerId, name: "Layer 1", visible: true, kind: "regular" },
    ],
    activeLayerId: defaultLayerId,
  };
}

/**
 * Layer state store - manages all layers and active layer
 */
export const layerStore = new Store<LayerState>(createInitialLayerState());
