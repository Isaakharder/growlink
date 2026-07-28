import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChecklistSignature, shouldSkipRegeneration } from "../reportGeneration";

// buildChecklistSignature is the upsert conflict target maybeCreateReport
// uses instead of a per-day key — this is what lets a second/third "Complete
// Another Report" attempt for the same location/date always produce its own
// independent report row, while two devices racing to finish the SAME
// attempt still collapse to exactly one report.

test("a single checklist id produces a stable signature", () => {
  assert.equal(buildChecklistSignature(["checklist-a"]), "checklist-a");
});

test("signature is independent of input order (two devices building the same set concurrently agree)", () => {
  const a = buildChecklistSignature(["checklist-b", "checklist-a"]);
  const b = buildChecklistSignature(["checklist-a", "checklist-b"]);
  assert.equal(a, b);
});

test("a different attempt (different checklist id) produces a different signature", () => {
  const attempt1 = buildChecklistSignature(["checklist-attempt-1"]);
  const attempt2 = buildChecklistSignature(["checklist-attempt-2"]);
  assert.notEqual(attempt1, attempt2);
});

test("a location with multiple simultaneously-due frequencies combines all checklist ids into one signature", () => {
  const signature = buildChecklistSignature(["daily-checklist", "weekly-checklist"]);
  assert.equal(signature, "daily-checklist|weekly-checklist");
});

test("three separate attempts for the same location/date each get distinct signatures", () => {
  const signatures = new Set([
    buildChecklistSignature(["attempt-1-id"]),
    buildChecklistSignature(["attempt-2-id"]),
    buildChecklistSignature(["attempt-3-id"])
  ]);
  assert.equal(signatures.size, 3);
});

// shouldSkipRegeneration is what keeps an admin's deletion (food_safety_delete_report,
// migration 0102) permanent against a repeat/offline-replayed /complete call:
// the checklist itself stays status='complete' after its report is deleted,
// so without this check maybeCreateReport would silently recreate it.

test("a checklist whose report was never deleted does not skip regeneration", () => {
  assert.equal(shouldSkipRegeneration([{ report_deleted_at: null }]), false);
});

test("a checklist tombstoned after its report was deleted skips regeneration", () => {
  assert.equal(shouldSkipRegeneration([{ report_deleted_at: "2026-07-28T12:00:00.000Z" }]), true);
});

test("any tombstoned checklist in the set is enough to skip, even if others are not", () => {
  assert.equal(
    shouldSkipRegeneration([{ report_deleted_at: null }, { report_deleted_at: "2026-07-28T12:00:00.000Z" }]),
    true
  );
});

test("an empty checklist set never skips (maybeCreateReport already returns early for that case)", () => {
  assert.equal(shouldSkipRegeneration([]), false);
});

test("a brand-new attempt started after the earlier one's report was deleted has its own null tombstone", () => {
  // Simulates "Complete Another Report": the new checklist row is a fresh
  // insert with report_deleted_at still null, independent of the prior
  // attempt's tombstone -- it must be allowed to generate its own report.
  const newAttempt = [{ report_deleted_at: null }];
  assert.equal(shouldSkipRegeneration(newAttempt), false);
});
