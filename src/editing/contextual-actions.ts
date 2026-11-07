/** Contextual selection/edit actions (duplicate, flip, simplify, vertex modes). */
import type { ToolId } from "../tools/registry";
import type { StageRenderer } from "../render/stage-renderer";
import type { SelectionController } from "./object-select";
import type { DirectSelectController } from "./direct-select";
import type { HistoryManager } from "../document/history";
import type { Camera } from "../render/camera";
import { setSelectionClipboardFromSelection } from "./selection-clipboard";
import type { SelectionState } from "../state/index";

export interface ContextualActionContext {
  tool: ToolId;
  /** Select-tool selection summary. */
  selection: SelectionState;
  pickedAnchorCount: number;
}

export interface ContextualActionMenuItem {
  id: string;
  name: string;
  negative?: boolean;
  draggable?: boolean;
}

interface ContextualActionDef extends ContextualActionMenuItem {
  isAvailable: (context: ContextualActionContext) => boolean;
  run: (context: ContextualActionContext, services: ContextualActionServices) => void;
}

export interface ContextualActionServices {
  renderer: StageRenderer;
  selectionController: SelectionController;
  directSelectController: DirectSelectController;
  historyManager: HistoryManager;
  camera: Camera;
  closePanel: () => void;
  moveSelectionToNewLayer: () => void;
  convertSelectionToSymbol: () => void;
  openSymbolInstancePopup: () => void;
}

const CONTEXTUAL_ACTION_REGISTRY: ContextualActionDef[] = [
  {
    id: "copy",
    name: "Copy",
    isAvailable: (context) => context.tool === "select" && context.selection.count > 0,
    run: (_context, services) => {
      setSelectionClipboardFromSelection(services.renderer);
    },
  },
  {
    id: "duplicate",
    name: "Duplicate",
    draggable: true,
    isAvailable: (context) => context.tool === "select" && context.selection.count > 0,
    run: (_context, services) => {
      const worldOffset = 10 / services.camera.zoom;
      services.selectionController.duplicateSelection(worldOffset, worldOffset);
    },
  },
  {
    id: "extract-layer",
    name: "Extract Layer",
    isAvailable: (context) => context.tool === "select" && context.selection.count > 0,
    run: (_context, services) => {
      services.moveSelectionToNewLayer();
    },
  },
  {
    id: "to-symbol",
    name: "To Symbol",
    isAvailable: (context) => context.tool === "select" && context.selection.count > 0,
    run: (_context, services) => {
      services.convertSelectionToSymbol();
    },
  },
  {
    id: "symbol-settings",
    name: "Symbol…",
    isAvailable: (context) =>
      context.tool === "select"
      && context.selection.count === 1
      && context.selection.instances.length === 1,
    run: (_context, services) => {
      services.openSymbolInstancePopup();
    },
  },
  {
    id: "flip-horizontal",
    name: "Flip Horizontal",
    isAvailable: (context) => context.tool === "select" && context.selection.count > 0,
    run: (_context, services) => {
      services.selectionController.flipSelection("horizontal");
    },
  },
  {
    id: "flip-vertical",
    name: "Flip Vertical",
    isAvailable: (context) => context.tool === "select" && context.selection.count > 0,
    run: (_context, services) => {
      services.selectionController.flipSelection("vertical");
    },
  },
  {
    id: "delete",
    name: "Delete",
    negative: true,
    isAvailable: (context) => context.tool === "select" && context.selection.count > 0,
    run: (_context, services) => {
      services.directSelectController.clearSelection();
      services.selectionController.deleteSelection();
      services.closePanel();
    },
  },
  {
    id: "simplify",
    name: "Simplify",
    draggable: true,
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.selection.count > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.simplifyPickedVertices();
    },
  },
  {
    id: "smooth",
    name: "Smooth",
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.selection.count > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.smoothPickedVertices();
    },
  },
  {
    id: "delete-vertices",
    name: "Delete",
    negative: true,
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.selection.count > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.deletePickedVertices();
      services.closePanel();
    },
  },
];

export function getAvailableContextualActions(context: ContextualActionContext): ContextualActionMenuItem[] {
  return CONTEXTUAL_ACTION_REGISTRY
    .filter((fn) => fn.isAvailable(context))
    .map(({ id, name, negative, draggable }) => ({ id, name, negative, draggable }));
}

export function runContextualAction(
  functionId: string,
  context: ContextualActionContext,
  services: ContextualActionServices,
): boolean {
  const fn = CONTEXTUAL_ACTION_REGISTRY.find((candidate) => candidate.id === functionId);
  if (!fn || !fn.isAvailable(context)) return false;
  fn.run(context, services);
  return true;
}
