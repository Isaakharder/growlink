import { test } from "node:test";
import assert from "node:assert/strict";
import { isUniqueViolation } from "../safeError";

// Pins down the exact decision that routes a duplicate-active-name insert/
// update to 409 instead of a generic 500 -- see cleaningLocations.ts's POST
// and PUT handlers. This is the only piece of that status-code logic that's
// meaningfully unit-testable in isolation; the 400/403/404/500 status
// choices around it are plain control flow tied to a live Supabase call and
// are covered by live HTTP verification instead (this repo has no DB-mocking
// setup, and adding one just for this would be a bigger change than the
// fix it's testing).
test("isUniqueViolation recognizes Postgres unique_violation (23505)", () => {
  assert.equal(isUniqueViolation({ code: "23505" }), true);
});

test("isUniqueViolation rejects other Postgres error codes", () => {
  assert.equal(isUniqueViolation({ code: "23502" }), false); // not-null violation
  assert.equal(isUniqueViolation({ code: "23503" }), false); // foreign key violation
  assert.equal(isUniqueViolation({ code: "42501" }), false); // insufficient privilege
});

test("isUniqueViolation rejects null/undefined errors without throwing", () => {
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation(undefined), false);
  assert.equal(isUniqueViolation({}), false);
});
