import { css } from "lit";
import type { FloatingPanel } from "../primitives/floating-panel";

export interface PanelVisibility {
  id: string;
  label: string;
  visible: boolean;
}

export type ToggleablePanel = FloatingPanel & HTMLElement;

export function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) {
    s = [...s].map((c) => c + c).join("");
  }
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** WCAG relative luminance for sRGB hex (0 = black, 1 = white). */
export function hexRelativeLuminance(hex: string): number | null {
  const rgb = parseHexRgb(hex);
  if (!rgb) return null;
  const lin = (u: number) => {
    u /= 255;
    return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(rgb.r);
  const G = lin(rgb.g);
  const B = lin(rgb.b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** 3D depth strip: mix toward black on light colors, toward white on dark colors. */
export function dockColorDepthStripColor(faceCss: string): string {
  const lum = hexRelativeLuminance(faceCss);
  const darkInkMaxLuminance = 0.1;
  if (lum !== null && lum < darkInkMaxLuminance) {
    return `color-mix(in srgb, ${faceCss} 76%, #ffffff)`;
  }
  return `color-mix(in srgb, ${faceCss} 76%, #000000)`;
}

export const PANEL_VISIBILITY_DEFAULTS: PanelVisibility[] = [
  { id: "universal-panel", label: "Settings", visible: false },
  { id: "layers-panel", label: "Layers", visible: false },
  { id: "wheel-panel", label: "Wheel", visible: false },
  { id: "view-panel", label: "View", visible: false },
  { id: "tools-panel", label: "Brush", visible: false },
  { id: "color-panel", label: "Color", visible: false },
];

export const TOP_BAR_PANEL_IDS = [
  "universal-panel",
  "layers-panel",
  "wheel-panel",
  "view-panel",
  "tools-panel",
  "color-panel",
] as const;

/** Quick-info chip kinds in the shortcuts panel. */
export type DockInfoChip = "mode" | "frame" | "zoom";

export const TOP_BAR_SHORTCUT_CHIPS: readonly DockInfoChip[] = ["mode", "frame", "zoom"];

/** Shared chip styles for compact dock readouts (top-bar shortcuts panel). */
export const dockChipStyles = css`
  .dock-status {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: stretch;
    gap: 6px;
    box-sizing: border-box;
  }

  .dock-cell {
    flex: 0 0 var(--inkwell-dock-control);
    width: var(--inkwell-dock-control);
    min-width: var(--inkwell-dock-control);
    max-width: var(--inkwell-dock-control);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    box-sizing: border-box;
  }

  .dock-cell .dock-chip-stacked,
  .dock-cell .dock-chip-reset {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .dock-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--inkwell-text-primary, #222);
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dock-chip-stacked {
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    gap: 1px;
    text-align: center;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  .dock-value {
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dock-prefix {
    flex-shrink: 0;
    font-weight: 500;
    color: var(--inkwell-text-muted, #666);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  button.dock-chip-reset {
    cursor: pointer;
    border: none;
    background: transparent;
    font: inherit;
    padding: 2px 4px;
    margin: 0;
    border-radius: 4px;
    color: inherit;
    max-width: 100%;
    min-width: 0;
  }

  button.dock-chip-reset:hover {
    background: color-mix(in srgb, var(--inkwell-text-primary, #222) 8%, transparent);
  }

  button.dock-chip-reset:focus-visible {
    outline: 2px solid var(--inkwell-panel-border, #555555);
    outline-offset: 1px;
  }
`;
