export type SelectionHandleId =
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

export interface SelectionHandle {
  id: SelectionHandleId;
  x: number;
  y: number;
}

export interface MergePassResult {
  survivors: paper.PathItem[];
  changedItems: paper.PathItem[];
}
