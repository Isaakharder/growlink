import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAnyPermission, requirePermission } from "../../../middleware/requirePermission";
import { fakeReqRes, stubMembership } from "./testHelpers";

// Exercises the existing, unmodified requirePermission/requireAnyPermission
// middleware (server/src/middleware/requirePermission.ts) against the
// food_safety:view / manage_departments / manage_locations keys, by
// stubbing supabase.from("memberships") for the duration of each test via
// node:test's built-in mock support. No database connection or migration is
// required — memberships already exists. See templatePermissions.test.ts
// for the equivalent coverage of food_safety:manage_templates.

test("owner bypasses food_safety:manage_departments", async (t) => {
  stubMembership(t, { role: "owner" });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await requirePermission("food_safety:manage_departments")(req, res, next);

  assert.equal(getResult().nextCalled, true);
  assert.equal(getResult().statusCode, null);
});

test("admin bypasses food_safety:view / manage checks", async (t) => {
  stubMembership(t, { role: "admin" });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await requireAnyPermission(["food_safety:view", "food_safety:manage_locations"])(req, res, next);

  assert.equal(getResult().nextCalled, true);
});

test("member with food_safety:view can view but cannot manage departments", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:view": true } });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await requireAnyPermission(["food_safety:view", "food_safety:manage_departments"])(req, res, next);
  assert.equal(getResult().nextCalled, true, "food_safety:view should grant the view route");

  stubMembership(t, { role: "member", permissions: { "food_safety:view": true } });
  const manage = fakeReqRes("user-1", "org-1");
  await requirePermission("food_safety:manage_departments")(manage.req, manage.res, manage.next);
  assert.equal(manage.getResult().nextCalled, false, "food_safety:view alone must not grant manage access");
  assert.equal(manage.getResult().statusCode, 403);
});

test("member with food_safety:manage_departments can also read departments (view-via-manage)", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:manage_departments": true } });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await requireAnyPermission(["food_safety:view", "food_safety:manage_departments"])(req, res, next);

  assert.equal(getResult().nextCalled, true);
});

test("food_safety:manage_departments does not grant food_safety:manage_locations", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:manage_departments": true } });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await requirePermission("food_safety:manage_locations")(req, res, next);

  assert.equal(getResult().nextCalled, false);
  assert.equal(getResult().statusCode, 403);
});

test("unrelated permissions do not grant Food Safety access", async (t) => {
  stubMembership(t, { role: "member", permissions: { "pest:edit": true, "payroll:view": true } });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await requireAnyPermission(["food_safety:view", "food_safety:manage_departments"])(req, res, next);

  assert.equal(getResult().nextCalled, false);
  assert.equal(getResult().statusCode, 403);
});

test("no membership row denies access", async (t) => {
  stubMembership(t, null);
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await requirePermission("food_safety:view")(req, res, next);

  assert.equal(getResult().nextCalled, false);
  assert.equal(getResult().statusCode, 403);
});
