/**
 * Panel event bridge
 *
 * Wires Lit panel custom-element events to App handler callbacks.
 * Keeps event names and HTML tags unchanged; App owns the behavior.
 */
import type { ToolId, AllToolSettings } from "../tools/registry";
import type {
  InkwellColorPanel,
  InkwellColorPopup,
  InkwellToolsPanel,
  InkwellToolSettingsPanel,
  InkwellUniversalPanel,
  InkwellViewPanel,
  InkwellShortcutsPanel,
  InkwellLayersPanel,
  InkwellWheelPanel,
  InkwellFunctionsPanel,
} from "../ui/register";
import { timelineStore } from "../document/document";

export type FrameRangeDetail = {
  layerId?: string;
  layerIds?: string[];
  start: number;
  end: number;
};

export type FrameRangeDeltaDetail = FrameRangeDetail & {
  delta: number;
};

export type PanelBridgeDeps = {
  colorPanel: InkwellColorPanel;
  colorPopup: InkwellColorPopup;
  toolsPanel: InkwellToolsPanel;
  toolSettingsPanel: InkwellToolSettingsPanel;
  universalPanel: InkwellUniversalPanel;
  viewPanel: InkwellViewPanel;
  shortcutsPanel: InkwellShortcutsPanel;
  layersPanel: InkwellLayersPanel;
  wheelPanel: InkwellWheelPanel;
  functionsPanel: InkwellFunctionsPanel;

  onColorPickerChange: (color: string) => void;
  onColorPickerChangeEnd: (color: string) => void;
  onStageColorPickerHidden: () => void;
  switchTool: (tool: ToolId) => void;
  onToolSettingsChange: (settings: AllToolSettings) => void;
  onPixelResChange: (scale: number) => void;
  onFlatten: () => void;
  onClear: () => void;
  onUndo: () => void;
  onRedo: () => void;
  setBrushSizeIndicatorEnabled: (enabled: boolean) => void;
  onOnionToggle: () => void;
  onDockZoomReset: () => void;
  onModeCycle: () => void;
  onPlayToggle: () => void;
  onAliasFixToggle: (enabled: boolean) => void;
  openStageColorPicker: (anchor: HTMLElement) => void;
  onStageSizeChange: () => void;
  onExportViewSvg: () => void;
  onDocSave: () => void;
  onDocOpen: () => void | Promise<void>;
  onDocNew: () => void;
  onTimelineFrameSelect: (
    frame: number,
    layerId?: string,
    options?: { navigateOnly?: boolean },
  ) => void;
  onKeyframeAdd: (blank: boolean) => void;
  onKeyframeRemove: (range?: FrameRangeDetail) => void;
  onFramesMove: (
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
    delta: number,
  ) => void;
  onFramesDuplicate: (
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) => void;
  onAutoMorphOpen: (
    layerIds: string[],
    start: number,
    end: number,
    anchor: HTMLElement,
  ) => void;
  onFramesDuplicateDragStart: (
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) => void;
  onFramesDuplicateDragEnd: (
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
    delta: number,
  ) => void;
  onFramesReverse: (
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) => void;
  onEditMultipleFramesToggle: (
    enabled: boolean,
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) => void;
  onKeyframeHoldToggle: (layerId: string, frame: number) => void;
  onAutoHoldToggle: () => void;
  onRealTimeLockToggle: () => void;
  onDurationSet: (frames: number) => void;
  onFrameRateChange: (rate: number) => void;
  onLayerAdd: (id: string, name: string) => void;
  onLayerDelete: (layerId: string) => void;
  onLayerSelect: (layerId: string) => void;
  onLayerVisibilityToggle: (layerId: string) => void;
  onLayerLockToggle: (layerId: string) => void;
  onLayerSoloToggle: (layerId: string) => void;
  onLayerReorder: (order: string[], movedId: string) => void;
  onLayerRename: (id: string, name: string) => void;
  onFunctionInvoke: (id: string) => void;
  onFunctionDragStart: (id: string) => void;
  onFunctionDragMove: (id: string, dx: number, dy: number) => void;
  onFunctionDragEnd: (id: string, dx: number, dy: number) => void;
  onFunctionsDismissed: () => void;
};

export function bindPanelEvents(deps: PanelBridgeDeps): void {
  const {
    colorPanel,
    colorPopup,
    toolsPanel,
    universalPanel,
    viewPanel,
    shortcutsPanel,
    layersPanel,
    wheelPanel,
    functionsPanel,
  } = deps;

  for (const picker of [colorPanel, colorPopup]) {
    picker.addEventListener("color-change", (e: Event) => {
      deps.onColorPickerChange((e as CustomEvent<string>).detail);
    });
    picker.addEventListener("color-change-end", (e: Event) => {
      deps.onColorPickerChangeEnd((e as CustomEvent<string>).detail);
    });
  }

  colorPopup.addEventListener("panel-visibility-change", (e: Event) => {
    const { visible } = (e as CustomEvent<{ id: string; visible: boolean }>).detail;
    if (!visible) deps.onStageColorPickerHidden();
  });

  // Tools panel events - sync to inputManager and handle selection placement
  toolsPanel.addEventListener("tool-change", (e: Event) => {
    const tool = (e as CustomEvent<ToolId>).detail;
    deps.switchTool(tool);
  });

  // Tool settings panel (opened via double-tap on a tool icon; not dock-toggled)
  const { toolSettingsPanel } = deps;
  toolSettingsPanel.addEventListener("settings-change", (e: Event) => {
    const settings = (e as CustomEvent<AllToolSettings>).detail;
    deps.onToolSettingsChange(settings);
  });

  toolSettingsPanel.addEventListener("pixel-res-change", (e: Event) => {
    deps.onPixelResChange((e as CustomEvent<number>).detail);
  });

  // Universal panel events
  universalPanel.addEventListener("flatten", () => deps.onFlatten());
  universalPanel.addEventListener("clear", () => deps.onClear());
  universalPanel.addEventListener("undo", () => deps.onUndo());
  universalPanel.addEventListener("redo", () => deps.onRedo());
  viewPanel.addEventListener("brush-size-toggle", (e: Event) => {
    deps.setBrushSizeIndicatorEnabled((e as CustomEvent<boolean>).detail);
  });
  viewPanel.addEventListener("onion-toggle", () => deps.onOnionToggle());
  shortcutsPanel.addEventListener("zoom-reset", () => deps.onDockZoomReset());
  shortcutsPanel.addEventListener("mode-cycle", () => deps.onModeCycle());
  shortcutsPanel.addEventListener("play-toggle", () => deps.onPlayToggle());
  universalPanel.addEventListener("alias-fix-toggle", (e: Event) => {
    deps.onAliasFixToggle((e as CustomEvent<boolean>).detail);
  });
  universalPanel.addEventListener("stage-color-picker-open", (e: Event) => {
    const anchor = (e as CustomEvent<HTMLElement>).detail;
    deps.openStageColorPicker(anchor);
  });
  universalPanel.addEventListener("stage-size-change", () => {
    deps.onStageSizeChange();
  });
  universalPanel.addEventListener("export-view-svg", () => deps.onExportViewSvg());
  universalPanel.addEventListener("doc-save", () => deps.onDocSave());
  universalPanel.addEventListener("doc-open", () => void deps.onDocOpen());
  universalPanel.addEventListener("doc-new", () => deps.onDocNew());

  // Timeline events (frames grid merged into the layers panel)
  layersPanel.addEventListener("frame-select", (e: Event) => {
    const { frame, layerId, navigateOnly } = (
      e as CustomEvent<{ frame: number; layerId?: string; navigateOnly?: boolean }>
    ).detail;
    deps.onTimelineFrameSelect(frame, layerId, { navigateOnly });
  });
  // Jog wheel: signed frame steps, wrapping around the timeline ends.
  wheelPanel.addEventListener("frame-step", (e: Event) => {
    const delta = (e as CustomEvent<number>).detail;
    const t = timelineStore.get();
    const next = (((t.currentFrame + delta) % t.duration) + t.duration) % t.duration;
    deps.onTimelineFrameSelect(next);
  });
  wheelPanel.addEventListener("play-toggle", () => deps.onPlayToggle());
  layersPanel.addEventListener("keyframe-add", (e: Event) => {
    const { blank } = (e as CustomEvent<{ blank: boolean }>).detail;
    deps.onKeyframeAdd(blank);
  });
  layersPanel.addEventListener("keyframe-remove", (e: Event) => {
    const range = (
      e as CustomEvent<FrameRangeDetail | null>
    ).detail;
    deps.onKeyframeRemove(range ?? undefined);
  });
  layersPanel.addEventListener("frames-move", (e: Event) => {
    const { layerId, layerIds, start, end, delta } = (
      e as CustomEvent<FrameRangeDeltaDetail>
    ).detail;
    deps.onFramesMove(layerIds, layerId, start, end, delta);
  });
  layersPanel.addEventListener("frames-duplicate", (e: Event) => {
    const { layerId, layerIds, start, end } = (
      e as CustomEvent<FrameRangeDetail>
    ).detail;
    deps.onFramesDuplicate(layerIds, layerId, start, end);
  });
  layersPanel.addEventListener("frames-duplicate-drag-start", (e: Event) => {
    const { layerId, layerIds, start, end } = (
      e as CustomEvent<FrameRangeDetail>
    ).detail;
    deps.onFramesDuplicateDragStart(layerIds, layerId, start, end);
  });
  layersPanel.addEventListener("frames-duplicate-drag-end", (e: Event) => {
    const { layerId, layerIds, start, end, delta } = (
      e as CustomEvent<FrameRangeDeltaDetail>
    ).detail;
    deps.onFramesDuplicateDragEnd(layerIds, layerId, start, end, delta);
  });
  layersPanel.addEventListener("frames-auto-morph", (e: Event) => {
    const { layerIds, start, end, anchor } = (
      e as CustomEvent<FrameRangeDetail & { anchor: HTMLElement }>
    ).detail;
    deps.onAutoMorphOpen(layerIds ?? [], start, end, anchor);
  });
  layersPanel.addEventListener("frames-reverse", (e: Event) => {
    const { layerId, layerIds, start, end } = (
      e as CustomEvent<FrameRangeDetail>
    ).detail;
    deps.onFramesReverse(layerIds, layerId, start, end);
  });
  layersPanel.addEventListener("frames-edit-multiple", (e: Event) => {
    const { enabled, layerId, layerIds, start, end } = (
      e as CustomEvent<FrameRangeDetail & { enabled: boolean }>
    ).detail;
    deps.onEditMultipleFramesToggle(enabled, layerIds, layerId, start, end);
  });
  layersPanel.addEventListener("keyframe-hold-toggle", (e: Event) => {
    const { frame, layerId } = (e as CustomEvent<{ frame: number; layerId: string }>).detail;
    deps.onKeyframeHoldToggle(layerId, frame);
  });
  layersPanel.addEventListener("auto-hold-toggle", () => {
    deps.onAutoHoldToggle();
  });
  layersPanel.addEventListener("real-time-lock-toggle", () => {
    deps.onRealTimeLockToggle();
  });
  layersPanel.addEventListener("duration-set", (e: Event) => {
    deps.onDurationSet((e as CustomEvent<number>).detail);
  });
  layersPanel.addEventListener("frame-rate-change", (e: Event) => {
    deps.onFrameRateChange((e as CustomEvent<number>).detail);
  });
  layersPanel.addEventListener("play-toggle", () => deps.onPlayToggle());

  // Layers panel events
  layersPanel.addEventListener("layer-add", (e: Event) => {
    const { id, name } = (e as CustomEvent<{ id: string; name: string }>).detail;
    deps.onLayerAdd(id, name);
  });
  layersPanel.addEventListener("layer-delete", (e: Event) => {
    const layerId = (e as CustomEvent<string>).detail;
    deps.onLayerDelete(layerId);
  });
  layersPanel.addEventListener("layer-select", (e: Event) => {
    const layerId = (e as CustomEvent<string>).detail;
    deps.onLayerSelect(layerId);
  });
  layersPanel.addEventListener("layer-visibility-toggle", (e: Event) => {
    const layerId = (e as CustomEvent<string>).detail;
    deps.onLayerVisibilityToggle(layerId);
  });
  layersPanel.addEventListener("layer-lock-toggle", (e: Event) => {
    const layerId = (e as CustomEvent<string>).detail;
    deps.onLayerLockToggle(layerId);
  });
  layersPanel.addEventListener("layer-solo-toggle", (e: Event) => {
    const layerId = (e as CustomEvent<string>).detail;
    deps.onLayerSoloToggle(layerId);
  });
  layersPanel.addEventListener("layer-reorder", (e: Event) => {
    const { order, movedId } = (
      e as CustomEvent<{ order: string[]; movedId: string }>
    ).detail;
    deps.onLayerReorder(order, movedId);
  });
  layersPanel.addEventListener("layer-rename", (e: Event) => {
    const { id, name } = (e as CustomEvent<{ id: string; name: string }>).detail;
    deps.onLayerRename(id, name);
  });

  // Functions panel events
  functionsPanel.addEventListener("function-invoke", (e: Event) => {
    const { id } = (e as CustomEvent<{ id: string }>).detail;
    deps.onFunctionInvoke(id);
  });
  functionsPanel.addEventListener("function-drag-start", (e: Event) => {
    const { id } = (e as CustomEvent<{ id: string; dx: number; dy: number }>).detail;
    deps.onFunctionDragStart(id);
  });
  functionsPanel.addEventListener("function-drag-move", (e: Event) => {
    const { id, dx, dy } = (e as CustomEvent<{ id: string; dx: number; dy: number }>).detail;
    deps.onFunctionDragMove(id, dx, dy);
  });
  functionsPanel.addEventListener("function-drag-end", (e: Event) => {
    const { id, dx, dy } = (e as CustomEvent<{ id: string; dx: number; dy: number }>).detail;
    deps.onFunctionDragEnd(id, dx, dy);
  });
  functionsPanel.addEventListener("functions-close", (e: Event) => {
    const { reason } = (e as CustomEvent<{ reason?: "dismissed" | "hidden" }>).detail ?? {};
    if (reason === "dismissed") {
      deps.onFunctionsDismissed();
    }
  });
}
