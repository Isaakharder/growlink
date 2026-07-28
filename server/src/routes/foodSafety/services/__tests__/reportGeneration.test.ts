import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChecklistSignature } from "../reportGeneration";

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
