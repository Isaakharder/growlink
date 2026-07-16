import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureRecordViewable,
  isDraftOwner,
  wouldBeSelfVerification
} from "../services/recordPermissions";
import { RecordApiError } from "../services/recordRevisions";
import type { FoodSafetyRecordRow } from "../types";
import { fakeReqRes, stubMembership } from "./testHelpers";

function fakeRecord(overrides: Partial<FoodSafetyRecordRow> = {}): FoodSafetyRecordRow {
  return {
    id: "record-1",
    organization_id: "org-1",
    template_id: "template-1",
    template_version_id: "version-1",
    department_id: null,
    location_id: null,
    status: "draft",
    answers_json: {},
    record_date: "2026-01-01",
    started_at: "2026-01-01T00:00:00.000Z",
    submitted_at: null,
    verified_at: null,
    rejected_at: null,
    completed_by_employee_id: null,
    completed_by_user_id: "user-owner",
    verified_by_employee_id: null,
    verified_by_user_id: null,
    rejected_by_user_id: null,
    rejection_reason: null,
    current_revision_number: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

// ── isDraftOwner ─────────────────────────────────────────────────────────────

test("isDraftOwner is true only for the exact creating user", () => {
  const record = fakeRecord({ completed_by_user_id: "user-owner" });
  assert.equal(isDraftOwner(record, "user-owner"), true);
  assert.equal(isDraftOwner(record, "user-other"), false);
  assert.equal(isDraftOwner(record, null), false);
});

// ── wouldBeSelfVerification ──────────────────────────────────────────────────

test("wouldBeSelfVerification detects a matching user id", () => {
  const record = fakeRecord({ completed_by_user_id: "user-a", completed_by_employee_id: null });
  assert.equal(wouldBeSelfVerification(record, "user-a", null), true);
  assert.equal(wouldBeSelfVerification(record, "user-b", null), false);
});

test("wouldBeSelfVerification detects a matching employee id", () => {
  const record = fakeRecord({ completed_by_user_id: "user-a", completed_by_employee_id: "emp-1" });
  assert.equal(wouldBeSelfVerification(record, "user-b", "emp-1"), true);
  assert.equal(wouldBeSelfVerification(record, "user-b", "emp-2"), false);
});

test("wouldBeSelfVerification is false when neither id is known", () => {
  const record = fakeRecord({ completed_by_user_id: null, completed_by_employee_id: null });
  assert.equal(wouldBeSelfVerification(record, null, null), false);
});

// ── ensureRecordViewable ─────────────────────────────────────────────────────

test("ensureRecordViewable allows the draft owner", async (t) => {
  stubMembership(t, { role: "member", permissions: {} });
  const { req } = fakeReqRes("user-owner", "org-1");
  const record = fakeRecord({ status: "draft", completed_by_user_id: "user-owner" });
  await assert.doesNotReject(() => ensureRecordViewable(req, record));
});

test("ensureRecordViewable blocks a non-owner without food_safety:verify from a draft", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:complete": true } });
  const { req } = fakeReqRes("user-other", "org-1");
  const record = fakeRecord({ status: "draft", completed_by_user_id: "user-owner" });
  await assert.rejects(() => ensureRecordViewable(req, record), (err) => err instanceof RecordApiError && err.status === 403);
});

test("ensureRecordViewable allows a food_safety:verify holder to view another user's draft", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:verify": true } });
  const { req } = fakeReqRes("user-supervisor", "org-1");
  const record = fakeRecord({ status: "draft", completed_by_user_id: "user-owner" });
  await assert.doesNotReject(() => ensureRecordViewable(req, record));
});

test("ensureRecordViewable allows owner/admin to view another user's draft (bypass)", async (t) => {
  stubMembership(t, { role: "admin" });
  const { req } = fakeReqRes("user-admin", "org-1");
  const record = fakeRecord({ status: "draft", completed_by_user_id: "user-owner" });
  await assert.doesNotReject(() => ensureRecordViewable(req, record));
});

test("ensureRecordViewable allows food_safety:view to see any non-draft record", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:view": true } });
  const { req } = fakeReqRes("user-viewer", "org-1");
  const record = fakeRecord({ status: "verified", completed_by_user_id: "user-owner" });
  await assert.doesNotReject(() => ensureRecordViewable(req, record));
});

test("ensureRecordViewable restricts a complete-only user to their own non-draft records", async (t) => {
  stubMembership(t, { role: "member", permissions: { "food_safety:complete": true } });
  const otherOwners = fakeReqRes("user-other", "org-1");
  const record = fakeRecord({ status: "verified", completed_by_user_id: "user-owner" });
  await assert.rejects(
    () => ensureRecordViewable(otherOwners.req, record),
    (err) => err instanceof RecordApiError && err.status === 403
  );

  stubMembership(t, { role: "member", permissions: { "food_safety:complete": true } });
  const owner = fakeReqRes("user-owner", "org-1");
  await assert.doesNotReject(() => ensureRecordViewable(owner.req, record));
});
