import type {
  FrameSelectionInput,
  LayersFrameSelection,
  ReverseMarker,
  TimelineSpanKeyframe,
} from "./types";

/** Clamp a dragged frame-range delta so at least one frame stays on the timeline. */
export function clampFrameMoveDelta(
  raw: number,
  rangeStart: number,
  rangeEnd: number,
  duration: number,
): number {
  return Math.max(-rangeEnd, Math.min(duration - 1 - rangeStart, raw));
}

export function clampFrameToDuration(frame: number, duration: number): number {
  return Math.max(0, Math.min(duration - 1, frame));
}

export function shiftedFrameRange(
  start: number,
  end: number,
  delta: number,
  duration: number,
): { start: number; end: number } {
  return {
    start: clampFrameToDuration(start + delta, duration),
    end: clampFrameToDuration(end + delta, duration),
  };
}

export function keyframeSpanEnd(
  kf: Pick<TimelineSpanKeyframe, "holdUntil">,
  duration: number,
): number {
  return Math.min(kf.holdUntil, duration - 1);
}

export function keyframeSpanLength(
  kf: Pick<TimelineSpanKeyframe, "frame" | "holdUntil">,
  duration: number,
): number {
  return Math.max(1, keyframeSpanEnd(kf, duration) - kf.frame + 1);
}

export function collectReverseMarkers(
  keyframes: TimelineSpanKeyframe[],
  start: number,
  end: number,
  duration: number,
): ReverseMarker[] {
  const markers: ReverseMarker[] = [];
  for (const kf of keyframes) {
    const spanEnd = keyframeSpanEnd(kf, duration);
    if (kf.frame > end || spanEnd < start) continue;
    const len = keyframeSpanLength(kf, duration);
    if (len === 1) {
      markers.push({ kind: "dot", fromF: kf.frame, blank: kf.blank });
    } else {
      markers.push({ kind: "pill", fromF: kf.frame, len });
    }
  }
  return markers;
}

export function layerActionDetail(sel: LayersFrameSelection) {
  return {
    layerId: sel.anchorLayerId,
    layerIds: [...sel.layerIds],
    start: sel.start,
    end: sel.end,
  };
}

export function normalizeLayersFrameSelection(
  sel: FrameSelectionInput | null,
): LayersFrameSelection | null {
  if (!sel) return null;
  return {
    start: sel.start,
    end: sel.end,
    layerIds: sel.layerIds ?? (sel.layerId ? [sel.layerId] : []),
    anchorLayerId: sel.layerId ?? sel.layerIds?.[0] ?? "",
  };
}
