/**
 * Generated crosshair cursor for drawing tools (CSS cursor: url(...)).
 * Hotspot at center; falls back to keyword `crosshair` if the data URL is unsupported.
 */
const SIZE = 32;
const HOTSPOT = SIZE / 2;
const ARM = 10;

let cachedCss: string | null = null;

function buildCrosshairDataUrl(): string {
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext("2d");
  if (!ctx) return "";

  const cx = HOTSPOT;
  const cy = HOTSPOT;

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Dark outline for contrast on light UI
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - ARM, cy);
  ctx.lineTo(cx + ARM, cy);
  ctx.moveTo(cx, cy - ARM);
  ctx.lineTo(cx, cy + ARM);
  ctx.stroke();

  // Bright interior
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(cx - ARM, cy);
  ctx.lineTo(cx + ARM, cy);
  ctx.moveTo(cx, cy - ARM);
  ctx.lineTo(cx, cy + ARM);
  ctx.stroke();

  return c.toDataURL("image/png");
}

/**
 * CSS `cursor` value: custom PNG + fallback keyword.
 */
export function getDrawingCrosshairCursorCss(): string {
  if (!cachedCss) {
    const url = buildCrosshairDataUrl();
    cachedCss = url
      ? `url("${url}") ${HOTSPOT} ${HOTSPOT}, crosshair`
      : "crosshair";
  }
  return cachedCss;
}
