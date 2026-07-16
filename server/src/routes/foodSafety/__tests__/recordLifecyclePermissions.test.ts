import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAnyPermission, requirePermission } from "../../../middleware/requirePermission";
import { fakeReqRes, stubMembership } from "./testHelpers";

// Exercises the existing, unmodified requirePermission/requireAnyPermission
// middleware against the Phase 3 keys (food_safety:complete,
// food_safety:verify, mobile:food_safety) and the AND-of-gates pattern used
// for mobile Food Safety routes (mobile:food_safety AND (complete OR
// verify)), the same way permissions.test.ts / templatePermissions.test.ts
// covered the Phase 1/2 keys.

const canComplete = requirePermission("food_safety:complete");
const canVerify = requirePermission("food_safety:verify");
const canViewRecords = requireAnyPermission(["food_safety:view", "food_safety:complete", "food_safety:verify"]);
const canAmend = requireAnyPermission(["food_safety:complete", "food_safety:verify"]);
const mobileGate = requirePermission("mobile:food_safety");
const mobileContentGate = requireAnyPermission(["food_safety:complete", "food_safety:verify"]);

test("owner bypasses food_safety:complete and food_safety:verify", async (t) => {
  stubMembership(t, { role: "owner" });
  const complete = fakeReqRes("user-1", "org-1");
  await canComplete(complete.req, complete.res, complete.next);
  assert.equal(complete.getResult().nextCalled, true);

  stubMembership(t, { role: "owner" });
  const verify = fakeReqRes("user-1", "org-1");
  await canVerify(verify.req, verify.res, verify.next);
  assert.equal(verify.getResult().nextCalled, true);
});

test("food_safety:complete does not grant food_safety:verify", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:complete": true } });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");
  await canVerify(req, res, next);
  assert.equal(getResult().nextCalled, false);
  assert.equal(getResult().statusCode, 403);
});

test("food_safety:verify does not grant food_safety:complete", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:verify": true } });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");
  await canComplete(req, res, next);
  assert.equal(getResult().nextCalled, false);
  assert.equal(getResult().statusCode, 403);
});

test("view/complete/verify each independently grant record read access", async (t) => {
  for (const key of ["food_safety:view", "food_safety:complete", "food_safety:verify"]) {
    stubMembership(t, { role: "member", permissions: { [key]: true } });
    const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");
    await canViewRecords(req, res, next);
    assert.equal(getResult().nextCalled, true, `${key} should grant record read access`);
  }
});

test("an unrelated permission does not grant record read access", async (t) => {
  stubMembership(t, { role: "member", permissions: { "payroll:view": true } });
  const { req, res, next, getResult } = fakeReqRes("user-1", "org-1");
  await canViewRecords(req, res, next);
  assert.equal(getResult().nextCalled, false);
  assert.equal(getResult().statusCode, 403);
});

test("amend is reachable with either complete or verify, not with view alone", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:complete": true } });
  const complete = fakeReqRes("user-1", "org-1");
  await canAmend(complete.req, complete.res, complete.next);
  assert.equal(complete.getResult().nextCalled, true);

  stubMembership(t, { role: "member", permissions: { "food_safety:verify": true } });
  const verify = fakeReqRes("user-1", "org-1");
  await canAmend(verify.req, verify.res, verify.next);
  assert.equal(verify.getResult().nextCalled, true);

  stubMembership(t, { role: "member", permissions: { "food_safety:view": true } });
  const view = fakeReqRes("user-1", "org-1");
  await canAmend(view.req, view.res, view.next);
  assert.equal(view.getResult().nextCalled, false);
});

test("mobile Food Safety routes require BOTH mobile:food_safety AND (complete OR verify)", async (t) => {
  // mobile:food_safety alone is never sufficient.
  stubMembership(t, { role: "member", permissions: { "mobile:food_safety": true } });
  const mobileOnly = fakeReqRes("user-1", "org-1");
  await mobileGate(mobileOnly.req, mobileOnly.res, mobileOnly.next);
  assert.equal(mobileOnly.getResult().nextCalled, true, "mobile:food_safety alone passes the first gate");
  const mobileOnlyContent = fakeReqRes("user-1", "org-1");
  stubMembership(t, { role: "member", permissions: { "mobile:food_safety": true } });
  await mobileContentGate(mobileOnlyContent.req, mobileOnlyContent.res, mobileOnlyContent.next);
  assert.equal(mobileOnlyContent.getResult().nextCalled, false, "but the content gate must still fail without complete/verify");

  // complete/verify alone (no mobile:food_safety) fails the first gate.
  stubMembership(t, { role: "member", permissions: { "food_safety:complete": true } });
  const completeOnly = fakeReqRes("user-1", "org-1");
  await mobileGate(completeOnly.req, completeOnly.res, completeOnly.next);
  assert.equal(completeOnly.getResult().nextCalled, false, "food_safety:complete alone must not grant mobile access");

  // Both together pass both gates.
  stubMembership(t, { role: "member", permissions: { "mobile:food_safety": true, "food_safety:complete": true } });
  const both = fakeReqRes("user-1", "org-1");
  await mobileGate(both.req, both.res, both.next);
  assert.equal(both.getResult().nextCalled, true);

  stubMembership(t, { role: "member", permissions: { "mobile:food_safety": true, "food_safety:complete": true } });
  const bothContent = fakeReqRes("user-1", "org-1");
  await mobileContentGate(bothContent.req, bothContent.res, bothContent.next);
  assert.equal(bothContent.getResult().nextCalled, true);
});

test("no membership row denies food_safety:complete and food_safety:verify", async (t) => {
  stubMembership(t, null);
  const complete = fakeReqRes("user-1", "org-1");
  await canComplete(complete.req, complete.res, complete.next);
  assert.equal(complete.getResult().nextCalled, false);

  stubMembership(t, null);
  const verify = fakeReqRes("user-1", "org-1");
  await canVerify(verify.req, verify.res, verify.next);
  assert.equal(verify.getResult().nextCalled, false);
});
