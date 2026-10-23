// Contract validation for docklink.growlink.pack_export v1 (no database).
// Run: node --require tsx/cjs --test src/lib/__tests__/docklinkPackExport.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { PackExportContractError, isoWeekStart, isoWeeksInYear, validatePackExport } from "../docklinkPackExport";

const DL_ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const fixture = () => JSON.parse(readFileSync(path.join(__dirname, "fixtures", "docklink-pack-export-v1.json"), "utf8"));

function problems(doc: unknown, org = DL_ORG): string[] {
  try {
    validatePackExport(doc, org);
    return [];
  } catch (e) {
    assert.ok(e instanceof PackExportContractError, String(e));
    return e.problems;
  }
}

test("ISO week helpers: Mondays, 53-week years and year boundaries", () => {
  assert.equal(isoWeekStart(2026, 45), "2026-11-02");
  assert.equal(isoWeekStart(2026, 1), "2025-12-29");
  assert.equal(isoWeekStart(2027, 1), "2027-01-04");
  assert.equal(isoWeeksInYear(2026), 53);
  assert.equal(isoWeeksInYear(2025), 52);
  assert.equal(isoWeeksInYear(2020), 53);
});

test("the mock fixture is a valid export and normalizes quantities and weeks", () => {
  const doc = validatePackExport(fixture(), DL_ORG.toUpperCase());
  assert.equal(doc.scope.status, "available");
  assert.deepEqual(doc.scope.first_week, { iso_year: 2026, iso_week: 45, week_start: "2026-11-02" });
  assert.equal(doc.packs.length, 8);
  assert.equal(doc.weekly_pack_totals.length, 15);
  const yellow47 = doc.weekly_pack_totals.find((r) => r.iso_week === 47 && r.series_key === "s-yellow-5kg")!;
  assert.equal(yellow47.total_cases, 312.5, "decimal string accepted and not rounded");
  const unattributed = doc.weekly_pack_totals.find((r) => r.attribution === "unattributed")!;
  assert.equal(unattributed.pack_id, null);
  assert.equal(unattributed.source_pack_ref, "pallet-name:Mixed Lot 7");
});

test("contract and version must match exactly", () => {
  assert.match(problems({ ...fixture(), contract: "docklink.other" }).join(), /contract must be/);
  assert.match(problems({ ...fixture(), version: 2 }).join(), /version must be 1/);
  assert.match(problems({ ...fixture(), version: "1" }).join(), /version must be 1/);
});

test("the export must be for the mapped organization", () => {
  assert.match(problems(fixture(), "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee").join(), /does not match the mapped DockLink organization/);
});

test("scope: status, required weeks, ordering and Monday week_start", () => {
  const doc = fixture();
  assert.match(problems({ ...doc, scope: { ...doc.scope, status: "maybe" } }).join(), /scope.status must be one of/);
  assert.match(problems({ ...doc, scope: { ...doc.scope, first_week: null } }).join(), /scope.first_week is required/);
  assert.match(
    problems({ ...doc, scope: { ...doc.scope, first_week: doc.scope.last_week, last_week: doc.scope.first_week } }).join(),
    /first_week is after scope.last_week/
  );
  assert.match(
    problems({ ...doc, scope: { ...doc.scope, first_week: { iso_year: 2026, iso_week: 45, week_start: "2026-11-01" } } }).join(),
    /is not the Monday of ISO 2026-W45/
  );
  assert.match(problems({ ...doc, scope: { ...doc.scope, transition_week: doc.scope.first_week } }).join(), /transition_week must be before/);
  assert.match(problems({ ...doc, scope: { ...doc.scope, last_week: { iso_year: 2025, iso_week: 53 } } }).join(), /has no week 53/);
});

test("pending and not-active exports are valid, carry no authoritative weeks, and their weekly rows are not applied", () => {
  for (const status of ["pending_first_full_week", "capture_not_active"]) {
    const doc = validatePackExport({ ...fixture(), scope: { ...fixture().scope, status, first_week: null, last_week: null } }, DL_ORG);
    assert.equal(doc.scope.status, status);
    assert.equal(doc.scope.first_week, null);
    assert.deepEqual(doc.weekly_pack_totals, []);
  }
});

test("row identity: duplicate (iso_year, iso_week, series_key) is rejected", () => {
  const doc = fixture();
  doc.weekly_pack_totals.push({ ...doc.weekly_pack_totals[0], total_cases: 1 });
  assert.match(problems(doc).join(), /duplicate identity \(2026, 45, s-red-5kg\)/);
});

test("rows outside the authoritative scope are rejected, not silently dropped", () => {
  const doc = fixture();
  doc.weekly_pack_totals.push({ ...doc.weekly_pack_totals[0], iso_week: 44, week_start: "2026-10-26" });
  assert.match(problems(doc).join(), /2026-W44 is outside the authoritative scope/);
});

test("quantities: negative, non-numeric and malformed totals are rejected; zero is allowed", () => {
  for (const bad of [-1, "abc", "1,5", null, "", "NaN", Number.POSITIVE_INFINITY]) {
    const doc = fixture();
    doc.weekly_pack_totals[0].total_cases = bad;
    assert.match(problems(doc).join(), /total_cases must be a non-negative decimal/, `total_cases ${JSON.stringify(bad)}`);
  }
  const doc = fixture();
  doc.weekly_pack_totals[0].total_cases = 0;
  assert.deepEqual(problems(doc), []);
  doc.weekly_pack_totals[0].load_count = -2;
  assert.match(problems(doc).join(), /load_count must be an integer >= 0/);
});

test("attribution must agree with pack_id", () => {
  const a = fixture();
  a.weekly_pack_totals[0].pack_id = null;
  assert.match(problems(a).join(), /attribution "pack" requires a pack_id/);
  const b = fixture();
  b.weekly_pack_totals.find((r: { attribution: string }) => r.attribution === "unattributed").pack_id = "x";
  assert.match(problems(b).join(), /must have pack_id null/);
  const c = fixture();
  c.weekly_pack_totals[0].attribution = "guess";
  assert.match(problems(c).join(), /attribution must be "pack" or "unattributed"/);
});

test("catalogue: duplicate pack ids and missing names are rejected", () => {
  const doc = fixture();
  doc.packs.push({ ...doc.packs[0] });
  doc.packs[1].name = "";
  const found = problems(doc).join();
  assert.match(found, /duplicate pack_id/);
  assert.match(found, /packs\[1\].name must be a non-empty string/);
});

test("every problem is reported at once, and nothing is returned", () => {
  const doc = { ...fixture(), version: 3, organization_id: "x", generated_at: "yesterday" };
  const found = problems(doc);
  assert.ok(found.length >= 3, found.join(" | "));
});

test("non-object documents are rejected", () => {
  assert.deepEqual(problems(null), ["export must be a JSON object"]);
  assert.deepEqual(problems([]), ["export must be a JSON object"]);
});
