// The Weekly kg by Variety source reader: full-history paging past
// PostgREST's 1,000-row cap, year separation, organization isolation, and
// refusing to return a partial read. Runs against an in-memory stand-in for
// the Supabase query builder that applies the same filters, ordering,
// ranges, row cap and exact counts the route relies on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  IncompleteReadError,
  WEEKLY_KG_PAGE_SIZE,
  fetchYearEntries,
  loadWeeklyKgByVarietySource
} from "../weeklyKgByVariety";

type Row = { id: string; organization_id: string; variety_id: string; year: number; week: number; total_kg: number | string };
const VARIETIES: Record<string, { name: string; status: string }> = {
  "v-red": { name: "Cadalora", status: "active" },
  "v-old": { name: "Levente", status: "inactive" },
  "v-other": { name: "Other org variety", status: "active" }
};

function fakeDb(rows: Row[], opts: { maxRows?: number; growAfterFirstPage?: Row[] } = {}) {
  const maxRows = opts.maxRows ?? 1000;
  const calls: Array<{ filters: Record<string, unknown>; range: [number, number] }> = [];
  let pagesServed = 0;
  const db = {
    from(table: string) {
      assert.equal(table, "yield_entries");
      const filters: Record<string, unknown> = {};
      const orders: Array<[string, boolean]> = [];
      let wantCount = false;
      let selected = "";
      const builder = {
        select(cols: string, o?: { count?: string }) {
          selected = cols;
          wantCount = o?.count === "exact";
          return builder;
        },
        eq(col: string, value: unknown) {
          filters[col] = value;
          return builder;
        },
        order(col: string, o: { ascending: boolean }) {
          orders.push([col, o.ascending]);
          return builder;
        },
        range(from: number, to: number) {
          calls.push({ filters: { ...filters }, range: [from, to] });
          if (opts.growAfterFirstPage && pagesServed === 1 && wantCount) rows.push(...opts.growAfterFirstPage.splice(0));
          pagesServed += 1;
          const matching = rows
            .filter((r) => Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v))
            .sort((a, b) => {
              for (const [col, asc] of orders) {
                const x = (a as Record<string, unknown>)[col] as string | number;
                const y = (b as Record<string, unknown>)[col] as string | number;
                if (x < y) return asc ? -1 : 1;
                if (x > y) return asc ? 1 : -1;
              }
              return 0;
            });
          const page = matching.slice(from, Math.min(to + 1, from + maxRows)).map((r) =>
            selected.includes("varieties(") ? { ...r, varieties: VARIETIES[r.variety_id] ?? null } : r
          );
          return Promise.resolve({ data: page, error: null, count: wantCount ? matching.length : null });
        }
      };
      return builder;
    }
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const ORG = "org-a";
let n = 0;
const row = (over: Partial<Row>): Row => ({ id: `e${String(++n).padStart(6, "0")}`, organization_id: ORG, variety_id: "v-red", year: 2026, week: 30, total_kg: 10, ...over });

test("reads every entry of the year across pages, beyond the 1,000-row cap", async () => {
  const rows = Array.from({ length: 2350 }, (_, i) => row({ week: 1 + (i % 50), total_kg: 1.25 }));
  const { db, calls } = fakeDb(rows);
  const source = await loadWeeklyKgByVarietySource(db, ORG, 2026);
  assert.equal(source.entryCount, 2350);
  assert.equal(source.entries.length, 2350);
  const yearCalls = calls.filter((c) => c.filters.year === 2026);
  assert.deepEqual(yearCalls.map((c) => c.range), [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(WEEKLY_KG_PAGE_SIZE, 1000);
});

test("keeps years separate, defaults to the latest year, and lists every year newest first", async () => {
  const rows = [row({ year: 2025, week: 50, total_kg: 7 }), row({ year: 2026, week: 31, total_kg: 5 }), row({ year: 2024, week: 2, total_kg: 1 })];
  const { db } = fakeDb(rows);
  const latest = await loadWeeklyKgByVarietySource(db, ORG, null);
  assert.equal(latest.year, 2026);
  assert.deepEqual(latest.years, [2026, 2025, 2024]);
  assert.deepEqual(latest.entries, [{ variety_id: "v-red", week: 31, total_kg: 5 }]);
  const older = await loadWeeklyKgByVarietySource(db, ORG, 2025);
  assert.deepEqual(older.entries, [{ variety_id: "v-red", week: 50, total_kg: 7 }]);
  const none = await loadWeeklyKgByVarietySource(db, ORG, 2019);
  assert.deepEqual({ ...none, years: none.years }, { year: 2019, years: [2026, 2025, 2024], entryCount: 0, varieties: [], entries: [] });
});

test("only reads the requesting organization's entries", async () => {
  const rows = [row({ total_kg: 3 }), row({ organization_id: "org-b", variety_id: "v-other", total_kg: 999 }), row({ organization_id: "org-b", year: 2031 })];
  const { db, calls } = fakeDb(rows);
  const source = await loadWeeklyKgByVarietySource(db, ORG, null);
  assert.deepEqual(source.years, [2026]);
  assert.deepEqual(source.entries, [{ variety_id: "v-red", week: 30, total_kg: 3 }]);
  assert.ok(calls.every((c) => c.filters.organization_id === ORG));
});

test("names each variety by id, including inactive ones, and keeps numeric strings exact", async () => {
  const rows = [row({ variety_id: "v-old", total_kg: "12.345" }), row({ variety_id: "v-red", total_kg: 0 })];
  const { db } = fakeDb(rows);
  const source = await loadWeeklyKgByVarietySource(db, ORG, 2026);
  assert.deepEqual(
    [...source.varieties].sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "v-old", name: "Levente", status: "inactive" },
      { id: "v-red", name: "Cadalora", status: "active" }
    ]
  );
  assert.deepEqual(source.entries.map((e) => e.total_kg).sort(), [0, 12.345]);
});

test("refuses a partial read: rows changing between pages, or fewer rows than counted", async () => {
  const rows = Array.from({ length: 1500 }, () => row({}));
  const { db } = fakeDb(rows, { growAfterFirstPage: [row({}), row({})] });
  await assert.rejects(() => fetchYearEntries(db, ORG, 2026), IncompleteReadError);

  // A server row cap below the page size would silently short every page.
  const capped = fakeDb(Array.from({ length: 1200 }, () => row({})), { maxRows: 500 });
  await assert.rejects(() => fetchYearEntries(capped.db, ORG, 2026), IncompleteReadError);
});

test("the route is read-only, behind yield view permission, and registered before the :id handlers", () => {
  const source = readFileSync(join(__dirname, "../../routes/yieldEntries.ts"), "utf8");
  assert.match(source, /yieldEntriesRouter\.get\("\/yield-entries\/weekly-by-variety", canYieldView,/);
  const route = source.indexOf('"/yield-entries/weekly-by-variety"');
  assert.ok(route > 0 && route < source.indexOf('yieldEntriesRouter.put("/yield-entries/:id"'));
  const body = source.slice(route, source.indexOf("});", route));
  assert.doesNotMatch(body, /\.(insert|update|upsert|delete)\(/);
});
