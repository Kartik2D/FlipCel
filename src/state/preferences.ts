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

export interface ViewOverlaySettings {
  gridEnabled: boolean;
  onionSkinOutline: boolean;
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

export type ThemeMode =
  | "light"
  | "dark"
  | "bubblegum"
  | "neon"
  | "notebook"
  | "ocean"
  | "matcha"
  | "twilight"
  | "berry";

export const THEME_STORAGE_KEY = "inkwell.theme";

export const THEME_OPTIONS: readonly ThemeMode[] = [
  "dark",
  "light",
  "notebook",
  "ocean",
  "matcha",
  "twilight",
  "berry",
  "bubblegum",
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
  light: {
    id: "light",
    label: "Light",
    colorScheme: "light",
    preview: {
      app: "#9a9a9a",
      panel: "#e6e6e6",
      border: "#484848",
      accent: "#4d73d7",
    },
  },
  dark: {
    id: "dark",
    label: "Dark",
    colorScheme: "dark",
    preview: {
      app: "#121212",
      panel: "#383838",
      border: "#8a8a8a",
      accent: "#7c9eff",
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
  neon: {
    id: "neon",
    label: "Neon",
    colorScheme: "dark",
    preview: {
      app: "#05060c",
      panel: "#14182a",
      border: "#3dffe0",
      accent: "#39ff9a",
    },
  },
  notebook: {
    id: "notebook",
    label: "Notebook",
    colorScheme: "light",
    preview: {
      app: "#c9bfb0",
      panel: "#f4efe6",
      border: "#6e6458",
      accent: "#7a8f6b",
    },
  },
  ocean: {
    id: "ocean",
    label: "Ocean",
    colorScheme: "light",
    preview: {
      app: "#8fb4c4",
      panel: "#e8f2f6",
      border: "#3d5f70",
      accent: "#3d8ea0",
    },
  },
  matcha: {
    id: "matcha",
    label: "Matcha",
    colorScheme: "light",
    preview: {
      app: "#9bb58a",
      panel: "#eef5e8",
      border: "#4a5e3f",
      accent: "#6a8f5a",
    },
  },
  twilight: {
    id: "twilight",
    label: "Twilight",
    colorScheme: "dark",
    preview: {
      app: "#1a1630",
      panel: "#2a2550",
      border: "#f0b060",
      accent: "#7b8cff",
    },
  },
  berry: {
    id: "berry",
    label: "Berry",
    colorScheme: "dark",
    preview: {
      app: "#1c1218",
      panel: "#3a2834",
      border: "#7dffc8",
      accent: "#ff6b9d",
    },
  },
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_OPTIONS as readonly string[]).includes(value);
}

export function readStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
  } catch {
    // ignore quota / privacy mode
  }
  return "dark";
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
