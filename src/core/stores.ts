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
 * View overlay preferences (grid, etc.) — Settings panel + UI canvas
 */
export interface ViewOverlaySettings {
  /** When false, the alignment grid is hidden. */
  gridEnabled: boolean;
  /** When true, draw the world origin axes and origin marker. */
  originEnabled: boolean;
  /** When true, draw bottom and right screen-size guides in world space. */
  screenSizeEnabled: boolean;
  /**
   * When true, grid spacing is recomputed from zoom so line density stays ~even on screen.
   * When false, world-space spacing stays fixed while you zoom (pan/rotate still apply).
   */
  gridLiveWhileZooming: boolean;
}

export const viewOverlayStore = new Store<ViewOverlaySettings>({
  gridEnabled: true,
  originEnabled: true,
  screenSizeEnabled: true,
  gridLiveWhileZooming: false,
});

// ============================================================
// Theme
// ============================================================

export type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "inkwell-theme-mode";

function getSystemThemeMode(): ThemeMode {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

function getStoredThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "light";

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Ignore storage access failures and fall back to system preference.
  }

  return getSystemThemeMode();
}

export const themeModeStore = new Store<ThemeMode>(getStoredThemeMode());

themeModeStore.subscribe((mode) => {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage access failures so theme switching still works in memory.
  }
});

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
// Layer Store
// ============================================================

/**
 * Layer definition
 */
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
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
    layers: [{ id: defaultLayerId, name: "Layer 1", visible: true }],
    activeLayerId: defaultLayerId,
  };
}

/**
 * Layer state store - manages all layers and active layer
 */
export const layerStore = new Store<LayerState>(createInitialLayerState());
