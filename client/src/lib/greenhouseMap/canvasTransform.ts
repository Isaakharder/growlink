// World (feet) <-> screen transform for the greenhouse map, copied from
// LabourLink web/src/lib/canvasTransform.ts: geometry stays in real feet and
// one translate + scale (pan in screen px, scale in px per foot) places it.

export interface CanvasTransform {
  pan: { x: number; y: number };
  scale: number;
}

interface LandSize {
  east_west_feet: number;
  north_south_feet: number;
}

/** Rescales around a screen point so the world point under it stays put (zoom to cursor). */
export function zoomAtPoint(current: CanvasTransform, newScale: number, focalX: number, focalY: number): CanvasTransform {
  const worldX = (focalX - current.pan.x) / current.scale;
  const worldY = (focalY - current.pan.y) / current.scale;
  return { scale: newScale, pan: { x: focalX - worldX * newScale, y: focalY - worldY * newScale } };
}

/** Fits the whole land in the viewport, centred, with a margin. */
export function computeFitTransform(land: LandSize, viewportWidth: number, viewportHeight: number, marginPx = 24): CanvasTransform {
  const availWidth = Math.max(1, viewportWidth - marginPx * 2);
  const availHeight = Math.max(1, viewportHeight - marginPx * 2);
  const scale = Math.min(availWidth / land.east_west_feet, availHeight / land.north_south_feet);
  return {
    scale,
    pan: { x: viewportWidth / 2 - (land.east_west_feet / 2) * scale, y: viewportHeight / 2 - (land.north_south_feet / 2) * scale }
  };
}

/** Keeps part of the land on screen so a pan can never lose it. */
export function clampPan(
  pan: { x: number; y: number },
  scale: number,
  land: LandSize,
  viewportWidth: number,
  viewportHeight: number,
  minVisiblePx = 80
): { x: number; y: number } {
  const w = land.east_west_feet * scale;
  const h = land.north_south_feet * scale;
  return {
    x: Math.min(Math.max(pan.x, minVisiblePx - w), viewportWidth - minVisiblePx),
    y: Math.min(Math.max(pan.y, minVisiblePx - h), viewportHeight - minVisiblePx)
  };
}
