import { describe, expect, it } from "vitest";
import { MAINTENANCE_ACCESS_PERMISSIONS } from "../access";

describe("MAINTENANCE_ACCESS_PERMISSIONS", () => {
  it("is the exact three-key set the server's maintenance routes accept (canView/canAct/canEdit union)", () => {
    expect(MAINTENANCE_ACCESS_PERMISSIONS).toEqual(["mobile:maintenance", "maintenance:view", "maintenance:edit"]);
  });
});
