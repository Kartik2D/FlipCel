/** Anchor identity keys for direct-select vertex picking. */

export type AnchorKey = string;

export interface AnchorHandle {
  item: paper.PathItem;
  childIndex: number;
  segmentIndex: number;
  key: AnchorKey;
  x: number;
  y: number;
}

export const anchorKey = (
  itemId: number,
  childIndex: number,
  segmentIndex: number,
): AnchorKey => `${itemId}:${childIndex}:${segmentIndex}`;

export const parseAnchorKey = (key: AnchorKey) => {
  const [i, c, s] = key.split(":").map(Number);
  return { itemId: i, childIndex: c, segmentIndex: s };
};
