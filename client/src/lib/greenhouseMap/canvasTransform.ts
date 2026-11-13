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

// ── View rotation ────────────────────────────────────────────────────────────
// A per-viewer preference: the saved layout stays north-up in feet, and the
// canvas draws it turned clockwise by 0/90/180/270°. Shapes are rotated in
// code (not with an SVG rotate), so text drawn at view coordinates is always
// upright and pan/zoom/fit work on the rotated land as if it were unrotated.

export type MapRotation = 0 | 90 | 180 | 270;

export const MAP_ROTATIONS: readonly MapRotation[] = [0, 90, 180, 270];

export function normalizeRotation(value: unknown): MapRotation {
  const n = Number(value);
  return (MAP_ROTATIONS as readonly number[]).includes(n) ? (n as MapRotation) : 0;
}

export function rotateBy(rotation: MapRotation, quarterTurnsClockwise: number): MapRotation {
  return ((((rotation + quarterTurnsClockwise * 90) % 360) + 360) % 360) as MapRotation;
}

/** The land's size as drawn: east–west and north–south swap at 90° and 270°. */
export function viewLandSize(land: LandSize, rotation: MapRotation): LandSize {
  return rotation === 90 || rotation === 270
    ? { east_west_feet: land.north_south_feet, north_south_feet: land.east_west_feet }
    : { east_west_feet: land.east_west_feet, north_south_feet: land.north_south_feet };
}

/** A world point (feet from west, feet from north) in rotated view feet. */
export function worldToView(land: LandSize, rotation: MapRotation, x: number, y: number): { x: number; y: number } {
  const W = land.east_west_feet;
  const H = land.north_south_feet;
  switch (rotation) {
    case 90:
      return { x: H - y, y: x };
    case 180:
      return { x: W - x, y: H - y };
    case 270:
      return { x: y, y: W - x };
    default:
      return { x, y };
  }
}

/** Inverse of worldToView. */
export function viewToWorld(land: LandSize, rotation: MapRotation, x: number, y: number): { x: number; y: number } {
  const W = land.east_west_feet;
  const H = land.north_south_feet;
  switch (rotation) {
    case 90:
      return { x: y, y: H - x };
    case 180:
      return { x: W - x, y: H - y };
    case 270:
      return { x: W - y, y: x };
    default:
      return { x, y };
  }
}

/** A world rectangle (top-left + size, in feet) as the rectangle drawn in view feet. */
export function worldRectToView(
  land: LandSize,
  rotation: MapRotation,
  rect: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const a = worldToView(land, rotation, rect.x, rect.y);
  const b = worldToView(land, rotation, rect.x + rect.width, rect.y + rect.height);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
