/** Selected frame range across one or more layer rows (inclusive). */
export type LayersFrameSelection = {
  start: number;
  end: number;
  layerIds: string[];
  /** Row where the drag started; horizontal actions use this layer only. */
  anchorLayerId: string;
};

/** Keyframe shape used by the timeline strip (panel-local view of store data). */
export type TimelineSpanKeyframe = {
  frame: number;
  blank: boolean;
  holdUntil: number;
};

export type ReverseMarker =
  | { kind: "dot"; fromF: number; blank: boolean }
  | { kind: "pill"; fromF: number; len: number };

export type FrameSelectionInput = {
  layerId?: string;
  layerIds?: string[];
  start: number;
  end: number;
};
