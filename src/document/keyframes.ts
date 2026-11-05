/**
 * Pure keyframe-span helpers shared by the DocumentManager, symbol
 * resolution, and offscreen exports. No Paper, no stores.
 */

export interface Keyframe {
  frameIndex: number;
  contentId: string;
  /**
   * Last frame (inclusive) this keyframe stays visible. Always in
   * [frameIndex, nextKeyframe.frameIndex - 1]. A plain keyframe has
   * holdUntil === frameIndex (one frame); larger values are explicit holds.
   * Blank keyframes are always single-frame (holdUntil === frameIndex).
   * Frames not covered by any keyframe's span render empty.
   */
  holdUntil: number;
}

/** Shared id for "empty layer" content, so blank layers/keyframes dedupe. */
export const EMPTY_CONTENT_ID = "empty";

/** Last keyframe with frameIndex <= frame, or null when none exists. */
export function previousKeyframeOf(
  track: { keyframes: Keyframe[] },
  frame: number,
): Keyframe | null {
  let previous: Keyframe | null = null;
  for (const kf of track.keyframes) {
    if (kf.frameIndex > frame) break;
    previous = kf;
  }
  return previous;
}

/**
 * The keyframe whose span (frameIndex..holdUntil) covers this frame, or
 * null when the frame is empty.
 */
export function coveringKeyframeOf(
  track: { keyframes: Keyframe[] },
  frame: number,
): Keyframe | null {
  const kf = previousKeyframeOf(track, frame);
  return kf && kf.holdUntil >= frame ? kf : null;
}

/** Content visible at a frame (empty when no keyframe span covers it). */
export function contentIdAtFrame(
  track: { keyframes: Keyframe[] },
  frame: number,
): string {
  return coveringKeyframeOf(track, frame)?.contentId ?? EMPTY_CONTENT_ID;
}
