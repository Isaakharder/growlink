import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural guard against the exact bug this was written to fix: the
// Mobile Home card and the /mobile/maintenance route guards independently
// hardcoding their own copy of the same three permission keys, which
// silently drifted apart. Behavioral tests elsewhere prove the card and
// route AGREE today; this proves they literally CANNOT disagree, because
// there is only one place the permission list is written down at all.
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("Maintenance access — single canonical source (no hardcoded duplicate)", () => {
  it("MobileHomePage imports MAINTENANCE_ACCESS_PERMISSIONS rather than declaring its own array", () => {
    const source = readSource("../../MobileHomePage.tsx");
    expect(source).toMatch(/import\s*\{\s*MAINTENANCE_ACCESS_PERMISSIONS\s*\}\s*from\s*["']\.\/maintenance\/access["']/);
    expect(source).toContain("canAny(MAINTENANCE_ACCESS_PERMISSIONS)");
    // The old duplicated literal must not reappear.
    expect(source).not.toMatch(/\["mobile:maintenance",\s*"maintenance:view",\s*"maintenance:edit"\]/);
  });

  it("routes.tsx uses MAINTENANCE_ACCESS_PERMISSIONS for both Maintenance route guards, not a hardcoded literal", () => {
    const source = readSource("../../../router/routes.tsx");
    expect(source).toMatch(/import\s*\{\s*MAINTENANCE_ACCESS_PERMISSIONS\s*\}\s*from\s*["']\.\.\/pages\/maintenance\/access["']/);
    const guardOccurrences = source.match(/permission=\{MAINTENANCE_ACCESS_PERMISSIONS\}/g) ?? [];
    // /mobile/maintenance and /mobile/maintenance/equipment/:equipmentId
    expect(guardOccurrences.length).toBe(2);
    expect(source).not.toMatch(/\["mobile:maintenance",\s*"maintenance:view",\s*"maintenance:edit"\]/);
  });

  it("MobileLayout's shell gate and getDefaultRoute derive Maintenance keys from the same constant", () => {
    const layoutSource = readSource("../../../components/layout/MobileLayout.tsx");
    expect(layoutSource).toMatch(/import\s*\{\s*MAINTENANCE_ACCESS_PERMISSIONS\s*\}\s*from\s*["']\.\.\/\.\.\/pages\/maintenance\/access["']/);
    expect(layoutSource).toContain("...MAINTENANCE_ACCESS_PERMISSIONS");

    const defaultRouteSource = readSource("../../../utils/getDefaultRoute.ts");
    expect(defaultRouteSource).toMatch(/import\s*\{\s*MAINTENANCE_ACCESS_PERMISSIONS\s*\}\s*from\s*["']\.\.\/pages\/maintenance\/access["']/);
    expect(defaultRouteSource).toContain("...MAINTENANCE_ACCESS_PERMISSIONS");
  });
});
