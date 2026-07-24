/**
 * Free helpers for solo-picked bezier tangent knobs (hit-test, linkage,
 * drag mutation, and chrome drawing). Kept out of DirectSelectController so
 * the drag/hit/draw logic can be reasoned about without instance state.
 */
import type { Point } from "../../geometry/types";
import type { PaperRenderer } from "../../render/paper-renderer";
import type { Camera } from "../../render/camera";
import paper from "paper";
import { type AnchorKey, parseAnchorKey } from "./anchors";

export type HandleLinkage = "mirrored" | "asymmetric" | "corner";

export type BezierHandleHit = {
  kind: "in" | "out";
  segmentKey: AnchorKey;
  linkage: HandleLinkage;
};

export type BezierHandleDrag = {
  kind: "in" | "out";
  segmentKey: AnchorKey;
  linkage: HandleLinkage;
};

/**
 * Classify the relationship between a segment's two tangent handles so the
 * drag logic can keep them linked. Two handles are considered colinear
 * when their normalized directions point nearly opposite one another
 * (dot product ≈ -1). If either handle is effectively zero-length the
 * anchor is treated as a corner and handles move independently.
 */
export function classifyHandleLinkage(seg: paper.Segment): HandleLinkage {
  const lenIn = seg.handleIn.length;
  const lenOut = seg.handleOut.length;
  const minLen = 1e-4;
  if (lenIn < minLen || lenOut < minLen) return "corner";

  const nin = seg.handleIn.divide(lenIn);
  const nout = seg.handleOut.divide(lenOut);
  const dot = nin.x * nout.x + nin.y * nout.y;
  // Colinear-opposite when dot ≈ -1. Allow a small tolerance so hand-tuned
  // handles that are visually symmetric still register as linked.
  if (dot > -0.999) return "corner";

  const relDiff = Math.abs(lenIn - lenOut) / Math.max(lenIn, lenOut);
  return relDiff < 0.01 ? "mirrored" : "asymmetric";
}

/**
 * Hit test the two tangent knobs of the solo-picked anchor, if any.
 * Returns null when no anchor is solo-picked, the resolved segment has
 * zero-length handles, or the pointer is outside the hit radius.
 */
export function hitTestBezierHandle(
  viewportPoint: Point,
  pickedAnchors: Set<AnchorKey>,
  paperRenderer: PaperRenderer,
  camera: Camera,
): BezierHandleHit | null {
  if (pickedAnchors.size !== 1) return null;
  const key = pickedAnchors.values().next().value as AnchorKey | undefined;
  if (!key) return null;

  const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
  const item = paperRenderer.getPathById(itemId);
  if (!item) return null;
  const seg = paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
  if (!seg) return null;

  const linkage = classifyHandleLinkage(seg);

  const hitRadiusSq = 10 * 10;
  const check = (
    handle: paper.Point,
    kind: "in" | "out",
  ): BezierHandleHit | null => {
    if (handle.isZero()) return null;
    const tipWorld = seg.point.add(handle);
    const tipScreen = camera.worldToScreen(tipWorld.x, tipWorld.y);
    const dx = viewportPoint.x - tipScreen.x;
    const dy = viewportPoint.y - tipScreen.y;
    if (dx * dx + dy * dy <= hitRadiusSq) {
      return { kind, segmentKey: key, linkage };
    }
    return null;
  };

  // Prefer handleOut when both overlap — matches the draw order (out drawn
  // last so it's visually on top) and gives deterministic picking.
  return check(seg.handleOut, "out") ?? check(seg.handleIn, "in");
}

/**
 * Set the dragged handle's world-space offset so its tip sits at the
 * pointer. Moves the in/out vector only — the anchor point itself is not
 * touched. Other segments on the path are unaffected.
 *
 * Returns true when the segment was found and mutated (caller should mark
 * dirty and redraw).
 */
export function dragBezierHandleTo(
  viewportPoint: Point,
  handleDrag: BezierHandleDrag,
  paperRenderer: PaperRenderer,
  camera: Camera,
): boolean {
  const { itemId, childIndex, segmentIndex } = parseAnchorKey(
    handleDrag.segmentKey,
  );
  const item = paperRenderer.getPathById(itemId);
  if (!item) return false;
  const seg = paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
  if (!seg) return false;

  const world = camera.screenToWorld(viewportPoint.x, viewportPoint.y);
  const newHandle = new paper.Point(
    world.x - seg.point.x,
    world.y - seg.point.y,
  );

  const linkage = handleDrag.linkage;
  const oppositeLength =
    handleDrag.kind === "in"
      ? seg.handleOut.length
      : seg.handleIn.length;

  if (handleDrag.kind === "in") {
    seg.handleIn = newHandle;
  } else {
    seg.handleOut = newHandle;
  }

  // When the two handles started the drag colinear-opposite (either
  // mirrored or asymmetric), keep them linked during drag by preserving
  // the opposite handle's original length and rotating its direction to
  // stay colinear-opposite. Mirrored anchors intentionally drop their
  // length-symmetry while the user is dragging — the opposite handle
  // keeps the length it had at drag-start rather than tracking the
  // dragged handle's new length.
  if (linkage !== "corner" && !newHandle.isZero() && oppositeLength > 1e-4) {
    const len = newHandle.length;
    const scale = -oppositeLength / len;
    const opposite = newHandle.multiply(scale);
    if (handleDrag.kind === "in") {
      seg.handleOut = opposite;
    } else {
      seg.handleIn = opposite;
    }
  }

  paper.view.update();
  return true;
}

/**
 * Render the two bezier control handles (in / out tangents) for the single
 * picked anchor. Skips either tangent when its handle vector is zero, i.e.
 * when the segment is a corner on that side.
 */
export function drawBezierHandlesForSoloPick(
  ctx: CanvasRenderingContext2D,
  pickedAnchors: Set<AnchorKey>,
  paperRenderer: PaperRenderer,
  camera: Camera,
): void {
  const key = pickedAnchors.values().next().value as AnchorKey | undefined;
  if (!key) return;

  const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
  const item = paperRenderer.getPathById(itemId);
  if (!item) return;

  const seg = paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
  if (!seg) return;

  const anchorScreen = camera.worldToScreen(seg.point.x, seg.point.y);

  const drawTangent = (handle: paper.Point) => {
    if (handle.isZero()) return;
    const tipWorld = seg.point.add(handle);
    const tipScreen = camera.worldToScreen(tipWorld.x, tipWorld.y);

    // Arm from anchor to handle tip: white halo then dark line for contrast
    // on both light and dark artwork.
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(anchorScreen.x, anchorScreen.y);
    ctx.lineTo(tipScreen.x, tipScreen.y);
    ctx.stroke();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(anchorScreen.x, anchorScreen.y);
    ctx.lineTo(tipScreen.x, tipScreen.y);
    ctx.stroke();

    // Handle knob: small circle (circles distinguish handles from the
    // square anchor nodes).
    const r = 3.5;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(tipScreen.x, tipScreen.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  drawTangent(seg.handleIn);
  drawTangent(seg.handleOut);
}
