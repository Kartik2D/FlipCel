/**
 * Shared help copy for button popups and the Tutorials panel.
 */

export type HelpSection =
  | "Tools"
  | "Dock"
  | "Playback"
  | "Timeline"
  | "Settings"
  | "View";

export type HelpId =
  | "tool.brush"
  | "tool.lasso"
  | "tool.fill"
  | "tool.select"
  | "tool.direct-select"
  | "tool.magnet"
  | "tool.magic-move"
  | "tool.magic-morph"
  | "tool.pan"
  | "tool.eyedropper"
  | "dock.settings"
  | "dock.layers"
  | "dock.wheel"
  | "dock.view"
  | "dock.tools"
  | "dock.color"
  | "dock.undo"
  | "dock.redo"
  | "dock.filename"
  | "dock.mode"
  | "dock.frame"
  | "dock.zoom"
  | "playback.lock-time"
  | "timeline.keyframe"
  | "timeline.blank"
  | "timeline.clear"
  | "timeline.auto-hold"
  | "timeline.emf"
  | "layers.add"
  | "layers.delete"
  | "layers.solo"
  | "layers.lock"
  | "layers.visibility"
  | "layers.merge-down"
  | "settings.history"
  | "settings.shortcuts"
  | "settings.tutorials"
  | "view.onion-active"
  | "view.onion-all";

export type HelpEntry = {
  id: HelpId;
  title: string;
  body: string;
  section: HelpSection;
};

const SECTION_ORDER: readonly HelpSection[] = [
  "Tools",
  "Dock",
  "Playback",
  "Timeline",
  "Settings",
  "View",
];

export const HELP_CATALOG: Record<HelpId, HelpEntry> = {
  "tool.brush": {
    id: "tool.brush",
    title: "Brush",
    body: "Paint strokes on the active layer.",
    section: "Tools",
  },
  "tool.lasso": {
    id: "tool.lasso",
    title: "Lasso Fill",
    body: "Draw a freeform shape to fill.",
    section: "Tools",
  },
  "tool.fill": {
    id: "tool.fill",
    title: "Fill",
    body: "Click a shape or enclosed pocket to recolor or fill it.",
    section: "Tools",
  },
  "tool.select": {
    id: "tool.select",
    title: "Select",
    body: "Drag a rectangle or freeform lasso to extract a selection. Hold Shift (Add to selection) to keep what’s already selected.",
    section: "Tools",
  },
  "tool.direct-select": {
    id: "tool.direct-select",
    title: "Direct Select",
    body: "Drag a rectangle or lasso to select vertices on the active layer. Hold Shift (Add to selection) to add anchors instead of replacing.",
    section: "Tools",
  },
  "tool.magnet": {
    id: "tool.magnet",
    title: "Magnet",
    body: "Snap and nudge artwork.",
    section: "Tools",
  },
  "tool.magic-move": {
    id: "tool.magic-move",
    title: "Magic Move",
    body: "Lasso a selection, then draw a trajectory with crossing timing ticks. When the chart is valid, an Apply popup appears.",
    section: "Tools",
  },
  "tool.magic-morph": {
    id: "tool.magic-morph",
    title: "Magic Morph",
    body: "With the playhead on a hold, draw a trajectory with timing ticks. Apply morphs to the next keyframe using chart ratios.",
    section: "Tools",
  },
  "tool.pan": {
    id: "tool.pan",
    title: "Pan",
    body: "Drag to pan the view; scroll to zoom.",
    section: "Tools",
  },
  "tool.eyedropper": {
    id: "tool.eyedropper",
    title: "Eyedropper",
    body: "Click artwork to pick its color.",
    section: "Tools",
  },
  "dock.settings": {
    id: "dock.settings",
    title: "Settings",
    body: "Undo/redo, history, shortcuts, tutorials, file actions, theme, and stage options.",
    section: "Dock",
  },
  "dock.layers": {
    id: "dock.layers",
    title: "Layers",
    body: "Layers list and timeline.",
    section: "Dock",
  },
  "dock.wheel": {
    id: "dock.wheel",
    title: "Wheel",
    body: "Jog wheel for scrubbing and playback.",
    section: "Dock",
  },
  "dock.view": {
    id: "dock.view",
    title: "View",
    body: "Onion skin, grid, symmetry, and brush-size indicator.",
    section: "Dock",
  },
  "dock.tools": {
    id: "dock.tools",
    title: "Tools",
    body: "Show or hide the tools rail. The label shows the active tool.",
    section: "Dock",
  },
  "dock.color": {
    id: "dock.color",
    title: "Color",
    body: "Color panel. The swatch shows the current paint color.",
    section: "Dock",
  },
  "dock.undo": {
    id: "dock.undo",
    title: "Undo",
    body: "Undo the last document change.",
    section: "Dock",
  },
  "dock.redo": {
    id: "dock.redo",
    title: "Redo",
    body: "Redo the last undone change.",
    section: "Dock",
  },
  "dock.filename": {
    id: "dock.filename",
    title: "File name",
    body: "Click to rename the current document.",
    section: "Dock",
  },
  "dock.mode": {
    id: "dock.mode",
    title: "Paint mode",
    body: "Click to cycle add / subtract / inside (when the active tool supports modes).",
    section: "Dock",
  },
  "dock.frame": {
    id: "dock.frame",
    title: "Frame",
    body: "Shows the current frame. Click to play or pause the timeline.",
    section: "Dock",
  },
  "dock.zoom": {
    id: "dock.zoom",
    title: "Zoom",
    body: "Shows the current zoom. Click to fit the stage in view.",
    section: "Dock",
  },
  "playback.lock-time": {
    id: "playback.lock-time",
    title: "Lock Time (LT)",
    body: "When on, changing fps rescales keyframes so the shot keeps the same wall-clock length (e.g. 30→60 fps turns each frame into a two-frame hold).",
    section: "Playback",
  },
  "timeline.keyframe": {
    id: "timeline.keyframe",
    title: "Insert keyframe",
    body: "Insert a keyframe that copies the current artwork at the playhead.",
    section: "Timeline",
  },
  "timeline.blank": {
    id: "timeline.blank",
    title: "Blank keyframe",
    body: "Insert a blank keyframe at the playhead.",
    section: "Timeline",
  },
  "timeline.clear": {
    id: "timeline.clear",
    title: "Clear frames",
    body: "Delete selected frames, or the frame at the playhead if nothing is selected.",
    section: "Timeline",
  },
  "timeline.auto-hold": {
    id: "timeline.auto-hold",
    title: "Auto hold",
    body: "When on, new keyframes extend the previous keyframe’s hold.",
    section: "Timeline",
  },
  "timeline.emf": {
    id: "timeline.emf",
    title: "Edit Multiple Frames",
    body: "When on, selecting a frame range edits those frames together on stage.",
    section: "Timeline",
  },
  "layers.add": {
    id: "layers.add",
    title: "Add layer",
    body: "Add a new layer above the selected layer.",
    section: "Timeline",
  },
  "layers.delete": {
    id: "layers.delete",
    title: "Delete layer",
    body: "Delete the current layer (stage and the last drawing layer cannot be removed).",
    section: "Timeline",
  },
  "layers.solo": {
    id: "layers.solo",
    title: "Solo",
    body: "Show only this layer. Tap again to exit solo and restore the other layers’ visibility.",
    section: "Timeline",
  },
  "layers.lock": {
    id: "layers.lock",
    title: "Lock",
    body: "Lock the layer so it can’t be edited or selected. Unlock to draw and transform on it again.",
    section: "Timeline",
  },
  "layers.visibility": {
    id: "layers.visibility",
    title: "Show / Hide",
    body: "Toggle whether this layer is visible on the stage. Hidden layers are skipped for drawing and selection.",
    section: "Timeline",
  },
  "layers.merge-down": {
    id: "layers.merge-down",
    title: "Merge Down",
    body: "Flatten this layer into the layer below it on every frame, then remove this layer.",
    section: "Timeline",
  },
  "settings.history": {
    id: "settings.history",
    title: "History",
    body: "Open the undo history window to jump to any snapshot.",
    section: "Settings",
  },
  "settings.shortcuts": {
    id: "settings.shortcuts",
    title: "Shortcuts",
    body: "Open the shortcuts window to view or remap keys, and see touch gestures (2-finger tap undo, 3-finger tap redo).",
    section: "Settings",
  },
  "settings.tutorials": {
    id: "settings.tutorials",
    title: "Tutorials",
    body: "Short walkthroughs for Morph, Move, holds, and Lock Time. Hover a control (or long-press) for quick tips.",
    section: "Settings",
  },
  "view.onion-active": {
    id: "view.onion-active",
    title: "Onion: Active",
    body: "Onion skin shows Nearest Frame on the active layer only.",
    section: "View",
  },
  "view.onion-all": {
    id: "view.onion-all",
    title: "Onion: All",
    body: "Onion skin shows Nearest Frame across all layers.",
    section: "View",
  },
};

export function getHelp(id: string | null | undefined): HelpEntry | undefined {
  if (!id) return undefined;
  return HELP_CATALOG[id as HelpId];
}

export function isHelpId(id: string): id is HelpId {
  return Object.prototype.hasOwnProperty.call(HELP_CATALOG, id);
}

/** Topics grouped for the Tutorials panel. */
export function listHelpSections(): { section: HelpSection; entries: HelpEntry[] }[] {
  const buckets = new Map<HelpSection, HelpEntry[]>();
  for (const section of SECTION_ORDER) buckets.set(section, []);
  for (const entry of Object.values(HELP_CATALOG)) {
    buckets.get(entry.section)?.push(entry);
  }
  return SECTION_ORDER.map((section) => ({
    section,
    entries: buckets.get(section) ?? [],
  })).filter((g) => g.entries.length > 0);
}

/** Map tool ids to help catalog ids. */
export function helpIdForTool(toolId: string): HelpId | undefined {
  const id = `tool.${toolId}` as HelpId;
  return HELP_CATALOG[id] ? id : undefined;
}
