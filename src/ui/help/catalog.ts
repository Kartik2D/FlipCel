/**
 * Shared help copy for hover / long-press info popups.
 */

import { formatBinding, shortcutsStore, type ToolActionId } from "../../input/shortcuts";

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
  | "tool.shape"
  | "tool.fill"
  | "tool.select"
  | "tool.direct-select"
  | "tool.create-points"
  | "tool.artistic-text"
  | "tool.magnet"
  | "tool.magic-move"
  | "tool.magic-morph"
  | "tool.pan"
  | "tool.eyedropper"
  | "dock.file"
  | "dock.settings"
  | "dock.layers"
  | "dock.wheel"
  | "dock.view"
  | "dock.assist"
  | "dock.library"
  | "dock.tools"
  | "dock.color"
  | "dock.undo"
  | "dock.redo"
  | "dock.filename"
  | "dock.frame"
  | "dock.zoom"
  | "playback.lock-time"
  | "timeline.keyframe"
  | "timeline.blank"
  | "timeline.clear"
  | "timeline.tag"
  | "timeline.auto-hold"
  | "timeline.emf"
  | "timeline.to-symbol"
  | "layers.add"
  | "layers.add-audio"
  | "layers.delete"
  | "layers.lock"
  | "layers.visibility"
  | "layers.merge-down"
  | "settings.history"
  | "settings.shortcuts"
  | "settings.reset-ui"
  | "settings.reset-all"
  | "view.onion-active"
  | "view.onion-all";

export type HelpEntry = {
  id: HelpId;
  title: string;
  body: string;
  section: HelpSection;
};

export const HELP_CATALOG: Record<HelpId, HelpEntry> = {
  "tool.brush": {
    id: "tool.brush",
    title: "Brush",
    body: "Draw on the current layer.",
    section: "Tools",
  },
  "tool.lasso": {
    id: "tool.lasso",
    title: "Lasso Fill",
    body: "Draw a freehand shape.",
    section: "Tools",
  },
  "tool.shape": {
    id: "tool.shape",
    title: "Shape",
    body: "Drag out a circle, rect, star, and so on. Shift locks the proportions.",
    section: "Tools",
  },
  "tool.fill": {
    id: "tool.fill",
    title: "Fill",
    body: "Click a shape or a closed gap to fill it.",
    section: "Tools",
  },
  "tool.select": {
    id: "tool.select",
    title: "Select",
    body: "Click a shape or symbol to select it. Drag a box or lasso to select more. Shift adds to the selection, or keeps a box square.",
    section: "Tools",
  },
  "tool.direct-select": {
    id: "tool.direct-select",
    title: "Direct Select",
    body: "Drag a box or lasso to grab points. Shift adds more, or keeps a box square.",
    section: "Tools",
  },
  "tool.create-points": {
    id: "tool.create-points",
    title: "Create Points",
    body: "Click to drop points. Click the first one again to close. Shift keeps the line straight, horizontal or vertical.",
    section: "Tools",
  },
  "tool.artistic-text": {
    id: "tool.artistic-text",
    title: "Artistic Text",
    body: "Drag to size it, then type. Enter places the text; Shift+Enter adds a line. Hold the tool to pick a font.",
    section: "Tools",
  },
  "tool.magnet": {
    id: "tool.magnet",
    title: "Magnet",
    body: "Nudge things so they snap into place.",
    section: "Tools",
  },
  "tool.magic-move": {
    id: "tool.magic-move",
    title: "Magic Move",
    body: "Lasso something, draw where it should go, and tick the path for timing. Apply when the popup shows up.",
    section: "Tools",
  },
  "tool.magic-morph": {
    id: "tool.magic-morph",
    title: "Magic Morph",
    body: "Park on a hold, draw a path with timing ticks, then Apply to morph into the next drawing.",
    section: "Tools",
  },
  "tool.pan": {
    id: "tool.pan",
    title: "Pan",
    body: "Drag to move around. Scroll to zoom.",
    section: "Tools",
  },
  "tool.eyedropper": {
    id: "tool.eyedropper",
    title: "Eyedropper",
    body: "Click something to grab its color.",
    section: "Tools",
  },
  "dock.file": {
    id: "dock.file",
    title: "Document",
    body: "Name, stage size, color, plus new, save, open, import, and export.",
    section: "Dock",
  },
  "dock.settings": {
    id: "dock.settings",
    title: "Settings",
    body: "History, shortcuts, theme, and a few other knobs.",
    section: "Dock",
  },
  "dock.layers": {
    id: "dock.layers",
    title: "Layers",
    body: "Your layers and the timeline.",
    section: "Dock",
  },
  "dock.wheel": {
    id: "dock.wheel",
    title: "Wheel",
    body: "Spin it to scrub. Play from the middle.",
    section: "Dock",
  },
  "dock.view": {
    id: "dock.view",
    title: "View",
    body: "Onion skin, grid, and brush size.",
    section: "Dock",
  },
  "dock.assist": {
    id: "dock.assist",
    title: "Assist",
    body: "Snap, symmetry, and Quick Shape.",
    section: "Dock",
  },
  "dock.library": {
    id: "dock.library",
    title: "Library",
    body: "Your symbols. Drag one onto the stage to place it, including inside another symbol. Select artwork and press F8 to make a new one.",
    section: "Dock",
  },
  "dock.tools": {
    id: "dock.tools",
    title: "Tools",
    body: "Show or hide the tools. The name is whatever you have selected.",
    section: "Dock",
  },
  "dock.color": {
    id: "dock.color",
    title: "Color",
    body: "Opens the color panel. The swatch is what you’re painting with.",
    section: "Dock",
  },
  "dock.undo": {
    id: "dock.undo",
    title: "Undo",
    body: "Undo the last thing you did.",
    section: "Dock",
  },
  "dock.redo": {
    id: "dock.redo",
    title: "Redo",
    body: "Redo what you just undid.",
    section: "Dock",
  },
  "dock.filename": {
    id: "dock.filename",
    title: "Document name",
    body: "The file name. It’s saved with the document and used when you download.",
    section: "Dock",
  },
  "dock.frame": {
    id: "dock.frame",
    title: "Frame",
    body: "The current frame. Click to play or pause.",
    section: "Dock",
  },
  "dock.zoom": {
    id: "dock.zoom",
    title: "Zoom",
    body: "The current zoom. Click to fit the stage.",
    section: "Dock",
  },
  "playback.lock-time": {
    id: "playback.lock-time",
    title: "Lock Time (LT)",
    body: "Keeps the shot the same length when you change fps. 30 to 60, for example, turns each frame into a two-frame hold.",
    section: "Playback",
  },
  "timeline.keyframe": {
    id: "timeline.keyframe",
    title: "Convert to keyframe",
    body: "Turn this frame into a keyframe. It copies what’s on screen.",
    section: "Timeline",
  },
  "timeline.blank": {
    id: "timeline.blank",
    title: "Convert to blank",
    body: "Turn this frame into an empty keyframe.",
    section: "Timeline",
  },
  "timeline.clear": {
    id: "timeline.clear",
    title: "Clear frames",
    body: "Deletes the selected frames. Nothing selected? It deletes the one you’re on.",
    section: "Timeline",
  },
  "timeline.tag": {
    id: "timeline.tag",
    title: "Tag frames",
    body: "Name a stretch of frames. Nothing selected? It tags three frames from here. Click a tag to rename or delete it; drag the edges to resize.",
    section: "Timeline",
  },
  "timeline.auto-hold": {
    id: "timeline.auto-hold",
    title: "Auto hold",
    body: "New keyframes keep the last drawing going until you replace it.",
    section: "Timeline",
  },
  "timeline.emf": {
    id: "timeline.emf",
    title: "Edit Multiple Frames",
    body: "Select a range of frames and edit them all at once.",
    section: "Timeline",
  },
  "timeline.to-symbol": {
    id: "timeline.to-symbol",
    title: "To Symbol",
    body: "Turn this frame range into a looping symbol. The range is replaced by one instance you can move, scale, and swap.",
    section: "Timeline",
  },
  "layers.add": {
    id: "layers.add",
    title: "Add layer",
    body: "Add a drawing layer above the one you have selected.",
    section: "Timeline",
  },
  "layers.add-audio": {
    id: "layers.add-audio",
    title: "Add audio layer",
    body: "Add an audio clip as its own layer. Drag the clip in the timeline to line it up with your frames.",
    section: "Timeline",
  },
  "layers.delete": {
    id: "layers.delete",
    title: "Delete layer",
    body: "Delete this layer. You can’t delete the stage or your last drawing layer.",
    section: "Timeline",
  },
  "layers.lock": {
    id: "layers.lock",
    title: "Lock",
    body: "Locks the layer so you can’t draw on it or pick it. Unlock to work on it again.",
    section: "Timeline",
  },
  "layers.visibility": {
    id: "layers.visibility",
    title: "Show / Hide",
    body: "Show or hide this layer. Hidden layers stay out of the way.",
    section: "Timeline",
  },
  "layers.merge-down": {
    id: "layers.merge-down",
    title: "Merge Down",
    body: "Merge this layer into the one below, on every frame.",
    section: "Timeline",
  },
  "settings.history": {
    id: "settings.history",
    title: "History",
    body: "Jump back to any earlier step.",
    section: "Settings",
  },
  "settings.shortcuts": {
    id: "settings.shortcuts",
    title: "Shortcuts",
    body: "See and change keyboard shortcuts. Two-finger tap undoes; three-finger tap redoes.",
    section: "Settings",
  },
  "settings.reset-ui": {
    id: "settings.reset-ui",
    title: "Reset UI",
    body: "Put the panels back where they started.",
    section: "Settings",
  },
  "settings.reset-all": {
    id: "settings.reset-all",
    title: "Reset all settings",
    body: "Puts theme, tools, shortcuts, and the UI back to defaults.",
    section: "Settings",
  },
  "view.onion-active": {
    id: "view.onion-active",
    title: "Onion: Active",
    body: "See nearby frames on this layer only.",
    section: "View",
  },
  "view.onion-all": {
    id: "view.onion-all",
    title: "Onion: All",
    body: "See nearby frames on every layer.",
    section: "View",
  },
};

export function getHelp(id: string | null | undefined): HelpEntry | undefined {
  if (!id) return undefined;
  const entry = HELP_CATALOG[id as HelpId];
  if (!entry) return undefined;
  // Tools: title includes the current chord, e.g. "Brush (B)".
  if (entry.section === "Tools") {
    const binding = shortcutsStore.get()[id as ToolActionId];
    if (binding) {
      return { ...entry, title: `${entry.title} (${formatBinding(binding)})` };
    }
  }
  return entry;
}

export function isHelpId(id: string): id is HelpId {
  return Object.prototype.hasOwnProperty.call(HELP_CATALOG, id);
}

/** Map tool ids to help catalog ids. */
export function helpIdForTool(toolId: string): HelpId | undefined {
  const id = `tool.${toolId}` as HelpId;
  return HELP_CATALOG[id] ? id : undefined;
}
