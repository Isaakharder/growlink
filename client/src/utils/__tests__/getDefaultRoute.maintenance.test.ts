import { describe, expect, it } from "vitest";
import { getDefaultRoute } from "../getDefaultRoute";

// Maintenance is mobile-only in v1 (no desktop page exists yet), so a
// member holding only maintenance:view/maintenance:edit/mobile:maintenance
// must land on /mobile, never "/" (which would be an empty/broken
// dashboard for them) and never /no-access (which would strand an
// authorized user).
describe("getDefaultRoute — Maintenance permissions", () => {
  it("routes a member with only maintenance:view to /mobile", () => {
    expect(getDefaultRoute("member", { "maintenance:view": true })).toBe("/mobile");
  });

  it("routes a member with only maintenance:edit to /mobile", () => {
    expect(getDefaultRoute("member", { "maintenance:edit": true })).toBe("/mobile");
  });

  it("routes a member with only mobile:maintenance to /mobile", () => {
    expect(getDefaultRoute("member", { "mobile:maintenance": true })).toBe("/mobile");
  });

  it("still routes a member with no permissions at all to /no-access", () => {
    expect(getDefaultRoute("member", {})).toBe("/no-access");
  });

  it("desktop permissions still win over maintenance permissions for a member holding both", () => {
    expect(getDefaultRoute("member", { "maintenance:view": true, "yield:view": true })).toBe("/");
  });

  it("owners/admins always land on / regardless of maintenance permissions", () => {
    expect(getDefaultRoute("owner", { "maintenance:view": true })).toBe("/");
    expect(getDefaultRoute("admin", {})).toBe("/");
  });
});
