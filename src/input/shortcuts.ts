/**
 * Remappable keyboard shortcuts + modifier-action bindings.
 *
 * Tool letter defaults come from ToolDefinition.hotkey; runtime lookup always
 * goes through shortcutsStore so remaps never require editing tool modules.
 */
import { Store } from "../state/store";
import { tools, type ToolId } from "../tools/registry";
import type { Modifiers } from "../geometry/types";

export const SHORTCUTS_STORAGE_KEY = "flipcel.shortcuts";

export type ModifierId = "shift" | "alt" | "ctrl" | "meta";

export type ChordBinding = {
  kind: "chord";
  key: string;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  /** Meta on macOS, Ctrl elsewhere. */
  mod?: boolean;
};

export type ModifierBinding = {
  kind: "modifier";
  modifier: ModifierId;
};

export type Binding = ChordBinding | ModifierBinding;

export type ToolActionId = `tool.${ToolId}`;
export type EditActionId = "edit.undo" | "edit.redo" | "edit.playToggle";
export type ModActionId = "mod.paintMode" | "mod.wheelPan";
export type ShortcutActionId = ToolActionId | EditActionId | ModActionId;

export type ShortcutBindings = Record<ShortcutActionId, Binding>;

export interface ShortcutActionMeta {
  id: ShortcutActionId;
  label: string;
  group: "tools" | "edit" | "modifiers";
}

/** Set while the Keyboard Shortcuts panel is capturing a rebind. */
let captureActive = false;

export function isShortcutsCaptureActive(): boolean {
  return captureActive;
}

export function setShortcutsCaptureActive(active: boolean) {
  captureActive = active;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function toolActionId(toolId: ToolId): ToolActionId {
  return `tool.${toolId}`;
}

export function getShortcutActions(): ShortcutActionMeta[] {
  const toolActions: ShortcutActionMeta[] = tools.map((t) => ({
    id: toolActionId(t.id),
    label: t.name,
    group: "tools",
  }));
  return [
    ...toolActions,
    { id: "edit.undo", label: "Undo", group: "edit" },
    { id: "edit.redo", label: "Redo", group: "edit" },
    { id: "edit.playToggle", label: "Play / Pause", group: "edit" },
    { id: "mod.paintMode", label: "Paint mode toggle", group: "modifiers" },
    { id: "mod.wheelPan", label: "Wheel pan", group: "modifiers" },
  ];
}

export function getDefaultBindings(): ShortcutBindings {
  const bindings = {} as ShortcutBindings;
  for (const tool of tools) {
    bindings[toolActionId(tool.id)] = {
      kind: "chord",
      key: tool.hotkey.toLowerCase(),
    };
  }
  bindings["edit.undo"] = { kind: "chord", key: "z", mod: true };
  bindings["edit.redo"] = { kind: "chord", key: "z", mod: true, shift: true };
  bindings["edit.playToggle"] = { kind: "chord", key: "space" };
  bindings["mod.paintMode"] = { kind: "modifier", modifier: "shift" };
  bindings["mod.wheelPan"] = { kind: "modifier", modifier: "shift" };
  return bindings;
}

type NormalizedChord = {
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
};

function normalizeKey(key: string): string {
  if (key === " ") return "space";
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

/** Expand a stored chord (incl. `mod`) into concrete modifier flags for this OS. */
export function expandChord(binding: ChordBinding): NormalizedChord {
  const key = normalizeKey(binding.key);
  const shift = !!binding.shift;
  const alt = !!binding.alt;
  let ctrl = !!binding.ctrl;
  let meta = !!binding.meta;
  if (binding.mod) {
    if (isMacPlatform()) meta = true;
    else ctrl = true;
  }
  return { key, shift, alt, ctrl, meta };
}

export function chordFromEvent(e: KeyboardEvent): ChordBinding {
  const key = normalizeKey(e.key);
  const mac = isMacPlatform();
  const binding: ChordBinding = { kind: "chord", key };

  if (e.shiftKey) binding.shift = true;
  if (e.altKey) binding.alt = true;

  if (mac) {
    if (e.metaKey) binding.mod = true;
    if (e.ctrlKey) binding.ctrl = true;
  } else {
    if (e.ctrlKey) binding.mod = true;
    if (e.metaKey) binding.meta = true;
  }

  return binding;
}

export function chordsEqual(a: ChordBinding, b: ChordBinding): boolean {
  const na = expandChord(a);
  const nb = expandChord(b);
  return (
    na.key === nb.key &&
    na.shift === nb.shift &&
    na.alt === nb.alt &&
    na.ctrl === nb.ctrl &&
    na.meta === nb.meta
  );
}

export function eventMatchesChord(e: KeyboardEvent, binding: ChordBinding): boolean {
  const want = expandChord(binding);
  return (
    normalizeKey(e.key) === want.key &&
    e.shiftKey === want.shift &&
    e.altKey === want.alt &&
    e.ctrlKey === want.ctrl &&
    e.metaKey === want.meta
  );
}

export function formatChord(binding: ChordBinding): string {
  const parts: string[] = [];
  const mac = isMacPlatform();
  if (binding.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.ctrl && !(binding.mod && !mac)) parts.push(mac ? "⌃" : "Ctrl");
  if (binding.alt) parts.push(mac ? "⌥" : "Alt");
  if (binding.shift) parts.push(mac ? "⇧" : "Shift");
  if (binding.meta && !(binding.mod && mac)) parts.push(mac ? "⌘" : "Meta");
  const keyLabel =
    binding.key === "space"
      ? "Space"
      : binding.key.length === 1
        ? binding.key.toUpperCase()
        : binding.key;
  parts.push(keyLabel);
  return parts.join(mac ? "" : "+");
}

export function formatModifier(mod: ModifierId): string {
  switch (mod) {
    case "shift":
      return "Shift";
    case "alt":
      return "Alt";
    case "ctrl":
      return "Ctrl";
    case "meta":
      return isMacPlatform() ? "⌘" : "Meta";
  }
}

export function formatBinding(binding: Binding): string {
  if (binding.kind === "modifier") return formatModifier(binding.modifier);
  return formatChord(binding);
}

export function isModifierHeld(modifiers: Modifiers, mod: ModifierId): boolean {
  return modifiers[mod];
}

export function eventHasModifier(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }, mod: ModifierId): boolean {
  switch (mod) {
    case "shift":
      return e.shiftKey;
    case "alt":
      return e.altKey;
    case "ctrl":
      return e.ctrlKey;
    case "meta":
      return e.metaKey;
  }
}

export function getModifierBinding(action: ModActionId, bindings = shortcutsStore.get()): ModifierId {
  const b = bindings[action];
  if (b?.kind === "modifier") return b.modifier;
  return action === "mod.paintMode" || action === "mod.wheelPan" ? "shift" : "shift";
}

export function isPaintModeModifierHeld(modifiers: Modifiers): boolean {
  return isModifierHeld(modifiers, getModifierBinding("mod.paintMode"));
}

/** Find the first chord action that matches this key event. */
export function matchChordAction(
  e: KeyboardEvent,
  bindings = shortcutsStore.get(),
): ShortcutActionId | null {
  // Prefer longer / more-specific chords: check edit actions before bare tool keys.
  const order: ShortcutActionId[] = [
    "edit.redo",
    "edit.undo",
    "edit.playToggle",
    ...tools.map((t) => toolActionId(t.id)),
  ];
  for (const id of order) {
    const b = bindings[id];
    if (b?.kind === "chord" && eventMatchesChord(e, b)) return id;
  }
  return null;
}

export function findChordConflict(
  actionId: ShortcutActionId,
  binding: ChordBinding,
  bindings = shortcutsStore.get(),
): ShortcutActionId | null {
  for (const [id, existing] of Object.entries(bindings) as [ShortcutActionId, Binding][]) {
    if (id === actionId) continue;
    if (existing.kind === "chord" && chordsEqual(existing, binding)) return id;
  }
  return null;
}

function isChordBinding(value: unknown): value is ChordBinding {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.kind === "chord" && typeof v.key === "string";
}

function isModifierBinding(value: unknown): value is ModifierBinding {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "modifier" &&
    (v.modifier === "shift" ||
      v.modifier === "alt" ||
      v.modifier === "ctrl" ||
      v.modifier === "meta")
  );
}

function sanitizeBindings(raw: unknown): ShortcutBindings {
  const defaults = getDefaultBindings();
  if (!raw || typeof raw !== "object") return defaults;
  const input = raw as Record<string, unknown>;
  const result = { ...defaults };
  for (const id of Object.keys(defaults) as ShortcutActionId[]) {
    const candidate = input[id];
    const def = defaults[id];
    if (def.kind === "chord" && isChordBinding(candidate)) {
      result[id] = {
        kind: "chord",
        key: normalizeKey(candidate.key),
        ...(candidate.shift ? { shift: true } : {}),
        ...(candidate.alt ? { alt: true } : {}),
        ...(candidate.ctrl ? { ctrl: true } : {}),
        ...(candidate.meta ? { meta: true } : {}),
        ...(candidate.mod ? { mod: true } : {}),
      };
    } else if (def.kind === "modifier" && isModifierBinding(candidate)) {
      result[id] = { kind: "modifier", modifier: candidate.modifier };
    }
  }
  return result;
}

export function readStoredShortcuts(): ShortcutBindings {
  try {
    const stored = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!stored) return getDefaultBindings();
    return sanitizeBindings(JSON.parse(stored));
  } catch {
    return getDefaultBindings();
  }
}

export function persistShortcuts(bindings: ShortcutBindings) {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // ignore quota / privacy mode
  }
}

export const shortcutsStore = new Store<ShortcutBindings>(readStoredShortcuts());

shortcutsStore.subscribe((bindings) => {
  persistShortcuts(bindings);
});

export function setBinding(actionId: ShortcutActionId, binding: Binding): string | null {
  if (binding.kind === "chord") {
    const conflict = findChordConflict(actionId, binding);
    if (conflict) {
      const meta = getShortcutActions().find((a) => a.id === conflict);
      return `Conflicts with ${meta?.label ?? conflict}`;
    }
  }
  shortcutsStore.update((current) => ({ ...current, [actionId]: binding }));
  return null;
}

export function resetBinding(actionId: ShortcutActionId) {
  const defaults = getDefaultBindings();
  shortcutsStore.update((current) => ({ ...current, [actionId]: defaults[actionId] }));
}

export function resetAllShortcuts() {
  shortcutsStore.set(getDefaultBindings());
}

export function parseToolActionId(id: ShortcutActionId): ToolId | null {
  if (!id.startsWith("tool.")) return null;
  const toolId = id.slice("tool.".length) as ToolId;
  return tools.some((t) => t.id === toolId) ? toolId : null;
}
