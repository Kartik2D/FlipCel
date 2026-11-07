/** Image keyframe payload in the content map. */
export function imageContent(assetId: string): string {
  return JSON.stringify({ asset: assetId });
}

export function parseImageContent(json: string): string | null {
  if (!json || json[0] !== "{") return null;
  try {
    const parsed = JSON.parse(json) as { asset?: unknown };
    return typeof parsed.asset === "string" && parsed.asset ? parsed.asset : null;
  } catch {
    return null;
  }
}
