/**
 * Presentation preferences (theme, color panel, view overlays, jog wheel).
 */
import { type ColorSpaceId, getColorSpaceAdapter } from "../color/spaces";
import { Store } from "./store";

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
  }),
);

/** Which layers contribute onion-skin ghosts. */
export type OnionSkinLayers = "active" | "all";

export interface ViewOverlaySettings {
  gridEnabled: boolean;
  onionSkinOutline: boolean;
  onionSkinLayers: OnionSkinLayers;
  gridSpacing: number;
  gridMajorEvery: number;
  gridMinorOpacity: number;
  gridMajorOpacity: number;
}

export function normalizeViewOverlaySettings(
  prefs: ViewOverlaySettings,
): ViewOverlaySettings {
  return {
    gridEnabled: prefs.gridEnabled,
    onionSkinOutline: prefs.onionSkinOutline,
    onionSkinLayers: prefs.onionSkinLayers === "all" ? "all" : "active",
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
    onionSkinLayers: "active",
    gridSpacing: 100,
    gridMajorEvery: 5,
    gridMinorOpacity: 0.06,
    gridMajorOpacity: 0.14,
  }),
);

export type ThemeMode =
  | "slab"
  | "light-slab"
  | "bubblegum"
  | "notebook"
  | "velvet"
  | "lagoon"
  | "neon";

export const THEME_STORAGE_KEY = "inkwell.theme";

export const THEME_OPTIONS: readonly ThemeMode[] = [
  "slab",
  "light-slab",
  "bubblegum",
  "notebook",
  "velvet",
  "lagoon",
  "neon",
];

/** Compact palette used by the settings theme preview glyph. */
export interface ThemePreviewColors {
  app: string;
  panel: string;
  border: string;
  accent: string;
}

export interface ThemeInfo {
  id: ThemeMode;
  label: string;
  /** Native UI color-scheme hint for form controls / scrollbars. */
  colorScheme: "light" | "dark";
  preview: ThemePreviewColors;
}

export const THEMES: Record<ThemeMode, ThemeInfo> = {
  slab: {
    id: "slab",
    label: "Slab",
    colorScheme: "dark",
    preview: {
      app: "#121212",
      panel: "#383838",
      border: "#8a8a8a",
      accent: "#7c9eff",
    },
  },
  "light-slab": {
    id: "light-slab",
    label: "Light Slab",
    colorScheme: "light",
    preview: {
      app: "#9a9a9a",
      panel: "#e6e6e6",
      border: "#484848",
      accent: "#4d73d7",
    },
  },
  bubblegum: {
    id: "bubblegum",
    label: "Bubblegum",
    colorScheme: "light",
    preview: {
      app: "#e8a0c0",
      panel: "#fff0f6",
      border: "#8a3d62",
      accent: "#e23d8b",
    },
  },
  notebook: {
    id: "notebook",
    label: "Notebook",
    colorScheme: "light",
    preview: {
      app: "#6e6458",
      panel: "#fffdf6",
      border: "#3d4f7a",
      accent: "#2f4f9a",
    },
  },
  velvet: {
    id: "velvet",
    label: "Velvet",
    colorScheme: "dark",
    preview: {
      app: "#120a10",
      panel: "#2a1822",
      border: "#c890a0",
      accent: "#e8a0b8",
    },
  },
  lagoon: {
    id: "lagoon",
    label: "Lagoon",
    colorScheme: "dark",
    preview: {
      app: "#071214",
      panel: "#162a30",
      border: "#6a9aa8",
      accent: "#3ecfbf",
    },
  },
  neon: {
    id: "neon",
    label: "Neon",
    colorScheme: "dark",
    preview: {
      app: "#05060c",
      panel: "#222a42",
      border: "#3dffe0",
      accent: "#39ff9a",
    },
  },
};

/** Map retired theme ids onto the current set. */
const THEME_MIGRATIONS: Record<string, ThemeMode> = {
  berry: "neon",
  dark: "slab",
  light: "light-slab",
  twilight: "neon",
  synth: "neon",
  banana: "notebook",
  matcha: "notebook",
  ocean: "lagoon",
  bamboo: "notebook",
  mist: "lagoon",
  ink: "lagoon",
  ember: "velvet",
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_OPTIONS as readonly string[]).includes(value);
}

export function readStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
    if (stored && stored in THEME_MIGRATIONS) return THEME_MIGRATIONS[stored];
  } catch {
    // ignore quota / privacy mode
  }
  return "slab";
}

export function persistTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // ignore quota / privacy mode
  }
}

export const themeModeStore = new Store<ThemeMode>(readStoredTheme());

export type WheelFriction = "low" | "medium" | "high";

export const WHEEL_FRICTION_OPTIONS: readonly WheelFriction[] = [
  "low",
  "medium",
  "high",
];

export interface WheelFrictionMotion {
  tauMs: number;
  settleDurationMs: number;
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
