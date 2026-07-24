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

export type ThemeMode = "light" | "dark";
export const themeModeStore = new Store<ThemeMode>("dark");

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
