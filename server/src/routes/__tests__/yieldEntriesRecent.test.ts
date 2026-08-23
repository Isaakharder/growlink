// Covers the cursor-based pagination added to GET /api/yield-entries/recent
// (the KgEntriesTab "Recent Entries" table), ordered by
// (year desc, week desc, packed_date desc nulls last, id desc).
//
// Investigation note (see the task that added this ordering): the "First
// Light Greenhouses" org has 56 yield_entries with a null packed_date, all
// in ISO weeks 17-24 of 2026. Cross-referencing yield_import_runs shows
// every one of them was created within ~0.1s of a yield_import_runs row
// from a FlowMaster **PDF** import (source filenames like "WEEK 19 1.pdf"),
// i.e. they are NOT manual entries — they're PDF imports from a period
// (2026-05-12 through 2026-06-13) before the FlowMaster date-extraction
// logic reliably produced a packed date. PDF imports from week 25 onward in
// the same org DO carry a packed_date, confirming this was a since-fixed
// parsing gap rather than an inherent property of manual or PDF-sourced
// entries. The only entries in this org with no matching yield_import_runs
// row at all (i.e. genuinely unmatched to any import — the closest proxy
// for "manual" available without a dedicated source column) are 8, and all
// 8 already have a non-null packed_date, consistent with the Kg Entries
// form always submitting one. None of the 56 are missing year or week —
// the column has a NOT NULL + CHECK(week between 1 and 53) constraint, so
// that's structurally guaranteed, not just empirically true here.
//
// The point of the ordering change stands regardless of root cause: any
// entry lacking a packed_date (manual or otherwise) must still sort next to
// its own (year, week) siblings instead of being pushed behind all dated
// history, which is what the tests below verify against these same 56 real
// rows.
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
  buildRecentCursorFilter,
  fetchRecentYieldEntriesPage,
} from "../yieldEntries";

// Organization used only for read-only pagination assertions below. Chosen
// because it has zero null-packed-date rows, isolating the keyset-with-nulls
// edge case (covered separately below) from the "walks every page without
// gaps" assertion.
const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";

// Has 56 null-packed_date rows spread across ISO weeks 17-24 of 2026 (see
// the file-level comment above) — this is what exercises the "a
// null-packed_date entry sorts within its own week, not after all dated
// history" behaviour that DENVA_ORG_ID (zero nulls) cannot.
const FIRST_LIGHT_ORG_ID = "e1b8a6cf-032c-48f0-852a-982dd58b9f9c";

test("parseRecentCursor round-trips a dated cursor", () => {
  const encoded = encodeRecentCursor(2026, 24, "2026-06-15", "ccd82e3c-2b71-46e1-b39e-a26f25790549");
  assert.equal(encoded, "2026_24_2026-06-15_ccd82e3c-2b71-46e1-b39e-a26f25790549");

  const parsed = parseRecentCursor(encoded);
  assert.deepEqual(parsed, {
    year: 2026,
    week: 24,
    packedDate: "2026-06-15",
    id: "ccd82e3c-2b71-46e1-b39e-a26f25790549",
  });
});

test("parseRecentCursor round-trips a null-packed-date cursor", () => {
  const encoded = encodeRecentCursor(2026, 19, null, "ccd82e3c-2b71-46e1-b39e-a26f25790549");
  assert.equal(encoded, "2026_19_null_ccd82e3c-2b71-46e1-b39e-a26f25790549");

  const parsed = parseRecentCursor(encoded);
  assert.deepEqual(parsed, {
    year: 2026,
    week: 19,
    packedDate: null,
    id: "ccd82e3c-2b71-46e1-b39e-a26f25790549",
  });
});

test("parseRecentCursor rejects malformed input", () => {
  assert.equal(parseRecentCursor(undefined), null);
  assert.equal(parseRecentCursor(""), null);
  assert.equal(parseRecentCursor("too_few_parts"), null);
  assert.equal(parseRecentCursor("2026_24_2026-06-15_not-a-uuid"), null);
  assert.equal(parseRecentCursor("not-a-year_24_2026-06-15_ccd82e3c-2b71-46e1-b39e-a26f25790549"), null);
  assert.equal(parseRecentCursor("2026_not-a-week_2026-06-15_ccd82e3c-2b71-46e1-b39e-a26f25790549"), null);
  assert.equal(parseRecentCursor("2026_24_not-a-date_ccd82e3c-2b71-46e1-b39e-a26f25790549"), null);
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

test("buildRecentCursorFilter: dated cursor covers earlier years/weeks, earlier-in-week dates, same-date ties, and the whole null tail", () => {
  const filter = buildRecentCursorFilter({ year: 2026, week: 24, packedDate: "2026-06-15", id: "abc" });
  assert.match(filter, /year\.lt\.2026/);
  assert.match(filter, /and\(year\.eq\.2026,week\.lt\.24\)/);
  assert.match(filter, /and\(year\.eq\.2026,week\.eq\.24,packed_date\.lt\.2026-06-15\)/);
  assert.match(filter, /and\(year\.eq\.2026,week\.eq\.24,packed_date\.is\.null\)/);
  assert.match(filter, /and\(year\.eq\.2026,week\.eq\.24,packed_date\.eq\.2026-06-15,id\.lt\.abc\)/);
});

test("buildRecentCursorFilter: null-packed_date cursor only continues the null tail of its own week", () => {
  const filter = buildRecentCursorFilter({ year: 2026, week: 19, packedDate: null, id: "abc" });
  assert.match(filter, /year\.lt\.2026/);
  assert.match(filter, /and\(year\.eq\.2026,week\.lt\.19\)/);
  assert.match(filter, /and\(year\.eq\.2026,week\.eq\.19,packed_date\.is\.null,id\.lt\.abc\)/);
  // Must NOT re-include already-seen dated rows of the same week.
  assert.doesNotMatch(filter, /packed_date\.lt\./);
});

test("fetchRecentYieldEntriesPage: initial page is ordered by year desc, week desc, packed_date desc", async () => {
  const page = await fetchRecentYieldEntriesPage(DENVA_ORG_ID, 7, null);

  assert.equal(page.entries.length, 7);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);

  for (let i = 1; i < page.entries.length; i += 1) {
    const prev = page.entries[i - 1];
    const curr = page.entries[i];
    const prevKey = prev.year * 100 + prev.week;
    const currKey = curr.year * 100 + curr.week;
    assert.ok(prevKey >= currKey, `expected year/week to be non-increasing: ${prevKey} >= ${currKey}`);
    if (prevKey === currKey) {
      assert.ok(
        (prev.packed_date ?? "") >= (curr.packed_date ?? ""),
        `within the same week, expected packed_date non-increasing: ${prev.packed_date} >= ${curr.packed_date}`
      );
    }
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
  // non-null packed_date. Guard with >= so the test still passes (rather
  // than under-counting silently) if more entries are added later; the
  // no-duplicates assertion above is the real check.
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

test(
  "fetchRecentYieldEntriesPage: null-packed_date entries sort within their own (year, week) group, " +
    "never duplicated or skipped across pages, and never pushed after an earlier week's dated entries",
  async () => {
    const seenIds = new Set<string>();
    const orderedEntries: Array<{ year: number; week: number; packed_date: string | null; id: string }> = [];
    let cursor = null as Awaited<ReturnType<typeof parseRecentCursor>>;
    let hasMore = true;
    let pages = 0;

    while (hasMore) {
      const page = await fetchRecentYieldEntriesPage(FIRST_LIGHT_ORG_ID, 25, cursor);
      for (const entry of page.entries) {
        assert.equal(seenIds.has(entry.id), false, `entry ${entry.id} was returned by more than one page`);
        seenIds.add(entry.id);
        orderedEntries.push(entry);
      }
      hasMore = page.hasMore;
      cursor = page.nextCursor ? parseRecentCursor(page.nextCursor) : null;
      pages += 1;
      assert.ok(pages < 50, "pagination did not terminate — possible cursor bug");
    }

    assert.ok(seenIds.size >= 126, `expected at least 126 entries, saw ${seenIds.size}`);

    // 1) (year, week) groups must be non-increasing and contiguous — i.e. once
    //    we move past a group we never see it again, and null-packed_date
    //    rows (which share their real week) never break this.
    let prevKey = Infinity;
    const groupBoundaries = new Set<number>();
    for (const entry of orderedEntries) {
      const key = entry.year * 100 + entry.week;
      assert.ok(key <= prevKey, `(year, week) group ${key} appeared after ${prevKey} — ordering broken`);
      if (key !== prevKey) {
        assert.equal(
          groupBoundaries.has(key),
          false,
          `(year, week) group ${key} appeared as two separate, non-contiguous blocks`
        );
        groupBoundaries.add(key);
      }
      prevKey = key;
    }

    // 2) Within every (year, week) group, dated entries must all precede any
    //    null-packed_date entries — proving nulls sort at the end of their
    //    OWN week's block, not the end of the whole table.
    const byGroup = new Map<number, Array<string | null>>();
    for (const entry of orderedEntries) {
      const key = entry.year * 100 + entry.week;
      const list = byGroup.get(key) ?? [];
      list.push(entry.packed_date);
      byGroup.set(key, list);
    }
    let sawGroupWithNullEntries = false;
    for (const [key, packedDates] of byGroup) {
      let seenNull = false;
      for (const pd of packedDates) {
        if (pd === null) {
          seenNull = true;
          sawGroupWithNullEntries = true;
        } else {
          assert.equal(seenNull, false, `group ${key}: a dated entry appeared after a null one`);
        }
      }
    }
    assert.ok(sawGroupWithNullEntries, "expected at least one (year, week) group to contain a null-packed_date entry");

    // Note on what's NOT asserted here: as of this test's writing, no
    // organization in the live DB has a single (year, week) group containing
    // BOTH a dated and a null-packed_date entry — First Light's 56 null rows
    // occupy weeks 17-24 entirely, its dated rows occupy weeks 25+ (see the
    // file-level comment). So this test can't show a real "Week 33 dated
    // entry sits next to a Week 33 null entry" example end-to-end. That exact
    // same-week interleave rule (dated rows before null rows, and a
    // null-packed_date cursor only ever continuing the null tail of its OWN
    // week) is instead proven directly against the query-building logic by
    // the buildRecentCursorFilter tests above, which is the actual mechanism
    // that would produce that interleave once such data exists.
  }
);

test("fetchRecentYieldEntriesPage: an organization with no entries returns an empty, non-paginated page", async () => {
  const page = await fetchRecentYieldEntriesPage("00000000-0000-0000-0000-000000000000", 7, null);
  assert.deepEqual(page.entries, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});
