/** Contextual selection/edit actions (duplicate, flip, simplify, vertex modes). */
import type { ToolId } from "../tools/registry";
import type { PaperRenderer } from "../render/paper-renderer";
import type { SelectionController } from "./object-select";
import type { DirectSelectController } from "./direct-select";
import type { HistoryManager } from "../document/history";
import type { Camera } from "../render/camera";
import { setSelectionClipboardFromItems } from "./selection-clipboard";
import { pathItemsOf } from "../state/index";
import { isSymbolInstance } from "../render/paper/symbol-instances";

export interface ContextualActionContext {
  tool: ToolId;
  /** Selected merge shapes and symbol instances. */
  items: paper.Item[];
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
  paperRenderer: PaperRenderer;
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
    isAvailable: (context) =>
      context.tool === "select" && pathItemsOf(context.items).length > 0,
    run: (context) => {
      setSelectionClipboardFromItems(pathItemsOf(context.items));
    },
  },
  {
    id: "duplicate",
    name: "Duplicate",
    draggable: true,
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (_context, services) => {
      const worldOffset = 10 / services.camera.zoom;
      services.selectionController.duplicateSelection(worldOffset, worldOffset);
    },
  },
  {
    id: "extract-layer",
    name: "Extract Layer",
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (_context, services) => {
      services.moveSelectionToNewLayer();
    },
  },
  {
    id: "to-symbol",
    name: "To Symbol",
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (_context, services) => {
      services.convertSelectionToSymbol();
    },
  },
  {
    id: "symbol-settings",
    name: "Symbol…",
    isAvailable: (context) =>
      context.tool === "select" && context.items.length === 1 && isSymbolInstance(context.items[0]),
    run: (_context, services) => {
      services.openSymbolInstancePopup();
    },
  },
  {
    id: "flip-horizontal",
    name: "Flip Horizontal",
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (context, services) => {
      services.paperRenderer.flipItemsInViewSpace(context.items, "horizontal");
      services.selectionController.markSelectionAsModified();
    },
  },
  {
    id: "flip-vertical",
    name: "Flip Vertical",
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (context, services) => {
      services.paperRenderer.flipItemsInViewSpace(context.items, "vertical");
      services.selectionController.markSelectionAsModified();
    },
  },
  {
    id: "delete",
    name: "Delete",
    negative: true,
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (context, services) => {
      for (const item of context.items) {
        services.paperRenderer.deleteItem(item);
      }
      services.directSelectController.clearSelection();
      services.selectionController.discardSelection();
      services.closePanel();
      services.historyManager.snapshot();
    },
  },
  {
    id: "simplify",
    name: "Simplify",
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.items.length > 0
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
      && context.items.length > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.smoothPickedVertices();
    },
  },
  {
    id: "round-corners",
    name: "Round Corners",
    draggable: true,
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.items.length > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.roundPickedCorners();
    },
  },
  {
    id: "point-sharp",
    name: "Sharp",
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.items.length > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.setPickedAnchorHandleMode("sharp");
    },
  },
  {
    id: "point-mirrored",
    name: "Mirrored",
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.items.length > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.setPickedAnchorHandleMode("mirrored");
    },
  },
  {
    id: "point-independent",
    name: "Independent",
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.items.length > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.setPickedAnchorHandleMode("independent");
    },
  },
  {
    id: "delete-vertices",
    name: "Delete",
    negative: true,
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.items.length > 0
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
