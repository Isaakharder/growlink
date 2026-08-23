// Covers the cursor-based pagination added to GET /api/yield-entries/recent
// (the KgEntriesTab "Recent Entries" table). The unit tests below exercise
// the pure cursor parse/encode/limit helpers offline; the integration tests
// exercise fetchRecentYieldEntriesPage directly against the real Supabase
// DB (read-only) to prove the keyset pagination actually walks an
// organization's yield_entries without skipping or duplicating rows, using
// the "Denva" test organization's existing, non-null-packed-date entries.
//
// dotenv/config is required first because yieldEntries.ts imports
// ../config/supabase, which throws at module load if SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY aren't set.
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRecentCursor,
  encodeRecentCursor,
  resolveRecentLimit,
  fetchRecentYieldEntriesPage,
} from "../yieldEntries";

// Organization used only for read-only pagination assertions below. Chosen
// because it has zero null-packed-date rows, isolating the keyset-with-nulls
// edge case (covered separately by the unit tests) from the "walks every
// page without gaps" assertion.
const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";

// Has a mix of dated and null-packed-date rows (126 entries, 56 with
// packed_date null as of this test's writing), which is what exercises the
// "packed_date IS NULL sorts after every dated row" branch of the keyset
// cursor that DENVA_ORG_ID (zero nulls) cannot.
const FIRST_LIGHT_ORG_ID = "e1b8a6cf-032c-48f0-852a-982dd58b9f9c";

test("parseRecentCursor round-trips a dated cursor", () => {
  const encoded = encodeRecentCursor("2026-06-15", "ccd82e3c-2b71-46e1-b39e-a26f25790549");
  assert.equal(encoded, "2026-06-15_ccd82e3c-2b71-46e1-b39e-a26f25790549");

  const parsed = parseRecentCursor(encoded);
  assert.deepEqual(parsed, {
    packedDate: "2026-06-15",
    id: "ccd82e3c-2b71-46e1-b39e-a26f25790549",
  });
});

test("parseRecentCursor round-trips a null-packed-date cursor", () => {
  const encoded = encodeRecentCursor(null, "ccd82e3c-2b71-46e1-b39e-a26f25790549");
  assert.equal(encoded, "null_ccd82e3c-2b71-46e1-b39e-a26f25790549");

  const parsed = parseRecentCursor(encoded);
  assert.deepEqual(parsed, { packedDate: null, id: "ccd82e3c-2b71-46e1-b39e-a26f25790549" });
});

test("parseRecentCursor rejects malformed input", () => {
  assert.equal(parseRecentCursor(undefined), null);
  assert.equal(parseRecentCursor(""), null);
  assert.equal(parseRecentCursor("no-separator-here"), null);
  assert.equal(parseRecentCursor("2026-06-15_not-a-uuid"), null);
  assert.equal(parseRecentCursor("not-a-date_ccd82e3c-2b71-46e1-b39e-a26f25790549"), null);
});

test("resolveRecentLimit defaults to 7 and clamps out-of-range values", () => {
  assert.equal(resolveRecentLimit(undefined), 7);
  assert.equal(resolveRecentLimit("not-a-number"), 7);
  assert.equal(resolveRecentLimit(0), 7);
  assert.equal(resolveRecentLimit(-5), 7);
  assert.equal(resolveRecentLimit(200), 7);
  assert.equal(resolveRecentLimit(25), 25);
  assert.equal(resolveRecentLimit("25"), 25);
});

test("fetchRecentYieldEntriesPage: initial page returns entries newest-first with a cursor", async () => {
  const page = await fetchRecentYieldEntriesPage(DENVA_ORG_ID, 7, null);

  assert.equal(page.entries.length, 7);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);

  for (let i = 1; i < page.entries.length; i += 1) {
    const prevDate = page.entries[i - 1].packed_date ?? "";
    const currDate = page.entries[i].packed_date ?? "";
    assert.ok(prevDate >= currDate, `expected ${prevDate} >= ${currDate} (newest-first order)`);
  }
});

test("fetchRecentYieldEntriesPage: walking every page visits each entry exactly once", async () => {
  const seenIds = new Set<string>();
  let cursor = null as Awaited<ReturnType<typeof parseRecentCursor>>;
  let hasMore = true;
  let pages = 0;

  while (hasMore) {
    const page = await fetchRecentYieldEntriesPage(DENVA_ORG_ID, 7, cursor);
    for (const entry of page.entries) {
      assert.equal(seenIds.has(entry.id), false, `entry ${entry.id} was returned by more than one page`);
      seenIds.add(entry.id);
    }
    hasMore = page.hasMore;
    cursor = page.nextCursor ? parseRecentCursor(page.nextCursor) : null;
    pages += 1;
    assert.ok(pages < 50, "pagination did not terminate — possible cursor bug");
  }

  // Denva org has 20 yield_entries as of this test's writing, all with
  // non-null packed_date (see task investigation). Guard with >= so the
  // test still passes (rather than under-counting silently) if more entries
  // are added later; the no-duplicates assertion above is the real check.
  assert.ok(seenIds.size >= 20, `expected at least 20 entries, saw ${seenIds.size}`);
  assert.ok(pages >= 3, `expected at least 3 pages of 7 to cover 20+ entries, saw ${pages}`);
});

test("fetchRecentYieldEntriesPage: page size matches the requested limit", async () => {
  const page = await fetchRecentYieldEntriesPage(DENVA_ORG_ID, 25, null);
  assert.ok(page.entries.length <= 25);
  // Denva has 20 entries total, so a limit of 25 should return everything in one page.
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test("fetchRecentYieldEntriesPage: null packed_date rows sort after every dated row and are never duplicated/skipped", async () => {
  const seenIds = new Set<string>();
  let cursor = null as Awaited<ReturnType<typeof parseRecentCursor>>;
  let hasMore = true;
  let pages = 0;
  let sawNull = false;
  let sawDatedAfterNull = false;

  while (hasMore) {
    const page = await fetchRecentYieldEntriesPage(FIRST_LIGHT_ORG_ID, 25, cursor);
    for (const entry of page.entries) {
      assert.equal(seenIds.has(entry.id), false, `entry ${entry.id} was returned by more than one page`);
      seenIds.add(entry.id);

      if (entry.packed_date === null) {
        sawNull = true;
      } else if (sawNull) {
        sawDatedAfterNull = true;
      }
    }
    hasMore = page.hasMore;
    cursor = page.nextCursor ? parseRecentCursor(page.nextCursor) : null;
    pages += 1;
    assert.ok(pages < 50, "pagination did not terminate — possible cursor bug");
  }

  assert.ok(seenIds.size >= 126, `expected at least 126 entries, saw ${seenIds.size}`);
  assert.ok(sawNull, "expected this organization to have at least one null-packed_date entry");
  assert.equal(sawDatedAfterNull, false, "a dated row appeared after a null row — nulls-last ordering is broken");
});

test("fetchRecentYieldEntriesPage: an organization with no entries returns an empty, non-paginated page", async () => {
  const page = await fetchRecentYieldEntriesPage("00000000-0000-0000-0000-000000000000", 7, null);
  assert.deepEqual(page.entries, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});
