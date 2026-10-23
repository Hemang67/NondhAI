export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Map a region chosen on a display (DIP coordinates relative to that display's top-left) to the
 * pixel rectangle inside the captured video of that display. The video may be any size (Windows
 * scaling, or downscaled capture), so this scales by video size / display size. Even dimensions
 * keep video encoders happy.
 */
export function regionToVideoCrop(region: Rect, display: { width: number; height: number }, video: { width: number; height: number }): Rect {
  const sx = video.width / display.width;
  const sy = video.height / display.height;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x = clamp(Math.round(region.x * sx), 0, video.width - 2);
  const y = clamp(Math.round(region.y * sy), 0, video.height - 2);
  const even = (v: number) => Math.max(2, v - (v % 2));
  const width = even(clamp(Math.round(region.width * sx), 2, video.width - x));
  const height = even(clamp(Math.round(region.height * sy), 2, video.height - y));
  return { x, y, width, height };
}

/** Scale a frame to fit within maxWidth × maxHeight (never up), keeping even dimensions. */
export function fitWithin(w: number, h: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const s = Math.min(1, maxWidth / w, maxHeight / h);
  const even = (v: number) => Math.max(2, Math.round(v) - (Math.round(v) % 2));
  return { width: even(w * s), height: even(h * s) };
}

/** Normalize a drag between two points into a rectangle. */
export function dragRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
