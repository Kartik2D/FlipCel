export type SelectionHandleId =
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate"
  /** Movable transform origin (single symbol instance only). */
  | "pivot";

export interface SelectionHandle {
  id: SelectionHandleId;
  x: number;
  y: number;
}

export interface MergePassResult {
  survivors: paper.PathItem[];
  changedItems: paper.PathItem[];
}
