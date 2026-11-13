import { describe, expect, it } from "vitest";
import { MAP_ROTATIONS, normalizeRotation, rotateBy, viewLandSize, viewToWorld, worldRectToView, worldToView } from "../canvasTransform";

const land = { east_west_feet: 300, north_south_feet: 200 };

describe("map view rotation", () => {
  it("turns the land a quarter at a time and swaps its drawn size at 90° and 270°", () => {
    expect(rotateBy(0, 1)).toBe(90);
    expect(rotateBy(270, 1)).toBe(0);
    expect(rotateBy(0, -1)).toBe(270);
    expect(rotateBy(90, -1)).toBe(0);
    expect(viewLandSize(land, 90)).toEqual({ east_west_feet: 200, north_south_feet: 300 });
    expect(viewLandSize(land, 180)).toEqual(land);
    expect(normalizeRotation("90")).toBe(90);
    expect(normalizeRotation("45")).toBe(0);
    expect(normalizeRotation(null)).toBe(0);
  });

  it("rotates clockwise: the north-west corner goes to the top-right at 90°", () => {
    expect(worldToView(land, 90, 0, 0)).toEqual({ x: 200, y: 0 });
    expect(worldToView(land, 180, 0, 0)).toEqual({ x: 300, y: 200 });
    expect(worldToView(land, 270, 0, 0)).toEqual({ x: 0, y: 300 });
  });

  it("maps every point back to the same world feet, at every orientation", () => {
    for (const r of MAP_ROTATIONS) {
      for (const [x, y] of [[0, 0], [12.5, 190], [299, 3], [150, 100]]) {
        const v = worldToView(land, r, x, y);
        expect(viewToWorld(land, r, v.x, v.y)).toEqual({ x, y });
      }
    }
  });

  it("keeps a rectangle's size (swapped at quarter turns) and keeps it inside the drawn land", () => {
    const rect = { x: 150, y: 10, width: 6, height: 120 };
    for (const r of MAP_ROTATIONS) {
      const v = worldRectToView(land, r, rect);
      const size = viewLandSize(land, r);
      const quarter = r === 90 || r === 270;
      expect([v.width, v.height]).toEqual(quarter ? [120, 6] : [6, 120]);
      expect(v.x).toBeGreaterThanOrEqual(0);
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.x + v.width).toBeLessThanOrEqual(size.east_west_feet);
      expect(v.y + v.height).toBeLessThanOrEqual(size.north_south_feet);
    }
  });
});
