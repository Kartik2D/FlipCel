import { css } from "lit";
import type { FloatingPanel } from "../primitives/floating-panel";

export interface PanelVisibility {
  id: string;
  label: string;
  visible: boolean;
  /**
   * Detached from the top dock (user dragged it free). Dock toggle is hidden
   * until the panel is closed, or dragged back onto the dock (which also
   * minimizes the panel).
   */
  detached: boolean;
}

export type ToggleablePanel = FloatingPanel & HTMLElement;

export const PANEL_VISIBILITY_DEFAULTS: PanelVisibility[] = [
  { id: "file-panel", label: "Document", visible: false, detached: false },
  { id: "universal-panel", label: "Settings", visible: false, detached: false },
  { id: "layers-panel", label: "Layers", visible: false, detached: false },
  { id: "wheel-panel", label: "Wheel", visible: true, detached: true },
  { id: "view-panel", label: "View", visible: false, detached: false },
  { id: "assist-panel", label: "Assist", visible: false, detached: false },
  { id: "library-panel", label: "Library", visible: false, detached: false },
  { id: "tools-panel", label: "Brush", visible: true, detached: true },
  { id: "color-panel", label: "Color", visible: false, detached: false },
];

export const TOP_BAR_PANEL_IDS = [
  "file-panel",
  "universal-panel",
  "layers-panel",
  "wheel-panel",
  "view-panel",
  "assist-panel",
  "library-panel",
  "tools-panel",
  "color-panel",
] as const;

/** Quick-info chip kinds in the actions dock. */
export type DockInfoChip = "frame" | "zoom";

/** Shared chip styles for compact dock readouts (top-bar shortcuts panel). */
export const dockChipStyles = css`
  .dock-cell {
    flex: 0 0 var(--flipcel-dock-control);
    width: var(--flipcel-dock-control);
    min-width: var(--flipcel-dock-control);
    max-width: var(--flipcel-dock-control);
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
    font-weight: 500;
    letter-spacing: var(--flipcel-letter-spacing, -0.011em);
    font-variant-numeric: tabular-nums;
    color: var(--flipcel-text-primary, #222);
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
    color: var(--flipcel-text-muted, #666);
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
    background: color-mix(in srgb, var(--flipcel-text-primary, #222) 8%, transparent);
  }

  button.dock-chip-reset:focus-visible {
    outline: 2px solid var(--flipcel-panel-border, #555555);
    outline-offset: 1px;
  }

  button.dock-chip-reset:disabled {
    opacity: 0.35;
    cursor: default;
    pointer-events: none;
  }

  button.dock-chip-reset:disabled:hover {
    background: transparent;
  }
`;
