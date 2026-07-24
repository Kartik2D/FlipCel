/** Contextual selection/edit actions (duplicate, flip, simplify, vertex modes). */
import type { ToolId } from "../tools/registry";
import type { PaperRenderer } from "../render/paper-renderer";
import type { SelectionController } from "./object-select";
import type { DirectSelectController } from "./direct-select";
import type { HistoryManager } from "../document/history";
import type { Camera } from "../render/camera";

export interface ContextualActionContext {
  tool: ToolId;
  items: paper.PathItem[];
  pickedAnchorCount: number;
}

export interface ContextualActionMenuItem {
  id: string;
  name: string;
  icon: string;
  danger?: boolean;
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
}

const CONTEXTUAL_ACTION_REGISTRY: ContextualActionDef[] = [
  {
    id: "duplicate",
    name: "Duplicate",
    icon: "copy",
    draggable: true,
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (context, services) => {
      const worldOffset = 10 / services.camera.zoom;
      const duplicates = context.items
        .map((item) => services.paperRenderer.duplicateItem(item, worldOffset, worldOffset))
        .filter((item): item is NonNullable<typeof item> => item !== null);
      services.selectionController.setSelectedItems(duplicates, { didMove: true });
    },
  },
  {
    id: "flip-horizontal",
    name: "Flip Horizontal",
    icon: "flip-horizontal",
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (context, services) => {
      services.paperRenderer.flipItemsInViewSpace(context.items, "horizontal");
      services.selectionController.markSelectionAsModified();
    },
  },
  {
    id: "flip-vertical",
    name: "Flip Vertical",
    icon: "flip-vertical",
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (context, services) => {
      services.paperRenderer.flipItemsInViewSpace(context.items, "vertical");
      services.selectionController.markSelectionAsModified();
    },
  },
  {
    id: "simplify",
    name: "Simplify",
    icon: "selection-simplify",
    isAvailable: (context) => context.tool === "select" && context.items.length > 0,
    run: (context, services) => {
      services.paperRenderer.simplifyItems(context.items);
      services.selectionController.markSelectionAsModified();
    },
  },
  {
    id: "delete",
    name: "Delete",
    icon: "trash",
    danger: true,
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
    id: "point-corner",
    name: "Corner",
    icon: "point-corner",
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.items.length > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.setPickedAnchorHandleMode("corner");
    },
  },
  {
    id: "point-mirrored",
    name: "Mirrored",
    icon: "point-mirrored",
    isAvailable: (context) =>
      context.tool === "direct-select"
      && context.items.length > 0
      && context.pickedAnchorCount > 0,
    run: (_context, services) => {
      services.directSelectController.setPickedAnchorHandleMode("mirrored");
    },
  },
  {
    id: "delete-vertices",
    name: "Delete Vertices",
    icon: "trash",
    danger: true,
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
    .map(({ id, name, icon, danger, draggable }) => ({ id, name, icon, danger, draggable }));
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
