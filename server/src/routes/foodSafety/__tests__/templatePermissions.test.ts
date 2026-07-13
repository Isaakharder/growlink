import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAnyPermission, requirePermission } from "../../../middleware/requirePermission";
import { userHasPermission } from "../services/permissionCheck";
import { fakeReqRes, stubMembership } from "./testHelpers";

const canView = requireAnyPermission(["food_safety:view", "food_safety:manage_templates"]);
const canManage = requirePermission("food_safety:manage_templates");

test("owner bypasses food_safety:manage_templates", async (t) => {
  stubMembership(t, { role: "owner" });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await canManage(req, res, next);

  assert.equal(getResult().nextCalled, true);
});

test("admin bypasses food_safety:manage_templates", async (t) => {
  stubMembership(t, { role: "admin" });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await canManage(req, res, next);

  assert.equal(getResult().nextCalled, true);
});

test("food_safety:view can read templates but cannot manage them", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:view": true } });
  const view = fakeReqRes("user-1", "org-1");
  await canView(view.req, view.res, view.next);
  assert.equal(view.getResult().nextCalled, true);

  stubMembership(t, { role: "member", permissions: { "food_safety:view": true } });
  const manage = fakeReqRes("user-1", "org-1");
  await canManage(manage.req, manage.res, manage.next);
  assert.equal(manage.getResult().nextCalled, false);
  assert.equal(manage.getResult().statusCode, 403);
});

test("food_safety:manage_templates can both read and manage", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:manage_templates": true } });
  const view = fakeReqRes("user-1", "org-1");
  await canView(view.req, view.res, view.next);
  assert.equal(view.getResult().nextCalled, true);

  stubMembership(t, { role: "member", permissions: { "food_safety:manage_templates": true } });
  const manage = fakeReqRes("user-1", "org-1");
  await canManage(manage.req, manage.res, manage.next);
  assert.equal(manage.getResult().nextCalled, true);
});

test("unrelated permission cannot access template routes", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:manage_departments": true } });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");

  await canView(req, res, next);

  assert.equal(getResult().nextCalled, false);
  assert.equal(getResult().statusCode, 403);
});

// userHasPermission() backs the in-handler "drafts are only visible to
// managers" check in templates.ts — verified directly here against the
// exact same food_safety:manage_templates key.
test("userHasPermission resolves true for owner without any permissions set", async (t) => {
  stubMembership(t, { role: "owner" });
  const { req } = fakeReqRes("user-1", "org-1");

  assert.equal(await userHasPermission(req, "food_safety:manage_templates"), true);
});

test("userHasPermission resolves true for a member with the exact key", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:manage_templates": true } });
  const { req } = fakeReqRes("user-1", "org-1");

  assert.equal(await userHasPermission(req, "food_safety:manage_templates"), true);
});

test("userHasPermission resolves false for a view-only member", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:view": true } });
  const { req } = fakeReqRes("user-1", "org-1");

  assert.equal(await userHasPermission(req, "food_safety:manage_templates"), false);
});
