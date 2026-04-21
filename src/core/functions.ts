import type { ToolId } from "./tools";
import type { PaperRenderer } from "./paper-renderer";
import type { SelectionController } from "./selection-controller";
import type { DirectSelectController } from "./direct-select-controller";
import type { HistoryManager } from "./history";
import type { Camera } from "./camera";

export interface FunctionContext {
  tool: ToolId;
  items: paper.PathItem[];
  pickedAnchorCount: number;
}

export interface FunctionMenuItem {
  id: string;
  name: string;
  icon: string;
  danger?: boolean;
  draggable?: boolean;
}

interface FunctionDef extends FunctionMenuItem {
  isAvailable: (context: FunctionContext) => boolean;
  run: (context: FunctionContext, services: FunctionServices) => void;
}

export interface FunctionServices {
  paperRenderer: PaperRenderer;
  selectionController: SelectionController;
  directSelectController: DirectSelectController;
  historyManager: HistoryManager;
  camera: Camera;
  closePanel: () => void;
}

const FUNCTION_REGISTRY: FunctionDef[] = [
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

export function getAvailableFunctions(context: FunctionContext): FunctionMenuItem[] {
  return FUNCTION_REGISTRY
    .filter((fn) => fn.isAvailable(context))
    .map(({ id, name, icon, danger, draggable }) => ({ id, name, icon, danger, draggable }));
}

export function runFunction(
  functionId: string,
  context: FunctionContext,
  services: FunctionServices,
): boolean {
  const fn = FUNCTION_REGISTRY.find((candidate) => candidate.id === functionId);
  if (!fn || !fn.isAvailable(context)) return false;
  fn.run(context, services);
  return true;
}
