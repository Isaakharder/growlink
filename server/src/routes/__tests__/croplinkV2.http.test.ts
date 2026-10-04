// CropLink v2 routes over HTTP with the real router + real integration-key
// middleware, backed by an in-memory store (no database, no credentials).
// Run: npm run test:croplink-v2
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createCroplinkV2Router, CroplinkV2Store } from "../croplinkV2";
import { createIntegrationKeyMiddleware, hashIntegrationKey, IntegrationKeyRecord } from "../../middleware/requireIntegrationKey";
import { DeletionRow, KeysetCursor, ManifestRow, MANIFEST_CHECKSUM_ALGORITHM, YieldWeekRow, manifestChecksum, YIELD_DETAIL_SCOPE } from "../../lib/croplinkV2";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const KEYS: Record<string, IntegrationKeyRecord> = {
  "gki_detail": { id: "k1", organization_id: ORG, integration_name: "croplink", scopes: ["harvest-actuals:read", YIELD_DETAIL_SCOPE] },
  "gki_legacy": { id: "k2", organization_id: ORG, integration_name: "croplink", scopes: null },
  "gki_v1only": { id: "k3", organization_id: ORG, integration_name: "croplink", scopes: ["harvest-actuals:read"] },
  "gki_other": { id: "k4", organization_id: OTHER_ORG, integration_name: "croplink", scopes: [YIELD_DETAIL_SCOPE] },
  "gki_wrongint": { id: "k5", organization_id: ORG, integration_name: "partner", scopes: [YIELD_DETAIL_SCOPE] }
};
const keyStore = {
  async findActiveByHash(hash: string) {
    const raw = Object.keys(KEYS).find(k => hashIntegrationKey(k) === hash);
    return raw ? KEYS[raw] : null;
  },
  async touch() {}
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ts = (sec: number) => `2026-09-${String(10 + Math.floor(sec / 86400)).padStart(2, "0")}T${String(Math.floor((sec % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}.000000+00:00`;

type Stored = YieldWeekRow & { organization_id: string };
let rows: Stored[] = [];
let deletions: (DeletionRow & { organization_id: string })[] = [];
const manifests = new Map<string, ManifestRow>();
let now = new Date("2026-10-04T12:00:00Z");

const after_ = (at: string, id: string, c: KeysetCursor) => at > c.at || (at === c.at && id > c.id);
const store: CroplinkV2Store = {
  async listYieldWeeks(org, { cursor, after: afterTs, year, limit }) {
    return rows
      .filter(r => r.organization_id === org && (year == null || r.year === year))
      .filter(r => (cursor ? after_(r.updated_at, r.id, cursor) : afterTs ? Date.parse(r.updated_at) > Date.parse(afterTs) : true))
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id.localeCompare(b.id)))
      .slice(0, limit);
  },
  async listDeletions(org, { cursor, after: afterTs, limit }) {
    return deletions
      .filter(d => d.organization_id === org)
      .filter(d => (cursor ? after_(d.deleted_at, d.id, cursor) : afterTs ? Date.parse(d.deleted_at) > Date.parse(afterTs) : true))
      .sort((a, b) => (a.deleted_at < b.deleted_at ? -1 : a.deleted_at > b.deleted_at ? 1 : a.id.localeCompare(b.id)))
      .slice(0, limit);
  },
  async createManifest(org, ttlMs) {
    const ids = rows.filter(r => r.organization_id === org).map(r => r.id).sort();
    const m: ManifestRow = { id: uuid(900000 + manifests.size), organization_id: org, entity_ids: ids, expected_count: ids.length, checksum: manifestChecksum(ids), algorithm: MANIFEST_CHECKSUM_ALGORITHM, created_at: now.toISOString(), expires_at: new Date(now.getTime() + ttlMs).toISOString() };
    manifests.set(m.id, m);
    return m;
  },
  async getManifest(org, id) {
    const m = manifests.get(id);
    return m && m.organization_id === org ? m : null;
  },
  async physicalAreas() {
    return new Map([[uuid(5000), { areaM2: 11600.5, rowCount: 40, rowsMissingDimensions: 0 }]]);
  }
};

function makeRow(n: number, updatedSec: number, org = ORG, week = 38): Stored {
  return {
    organization_id: org, id: uuid(n), variety_id: uuid(5000), year: 2026, week, packed_date: "2026-09-18", size_kg: {}, total_kg: 100 + n,
    average_fruit_weight_g: 200, kg_per_m2: 0.01, total_cases: 20, last_write_source: "import_pdf", created_at: ts(0), updated_at: ts(updatedSec),
    varieties: { name: "Mathieu", area_m2: 11627, updated_at: null }, yield_entry_daily_breakdown: []
  };
}

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", createCroplinkV2Router({
    store,
    authenticate: createIntegrationKeyMiddleware(keyStore, "croplink", YIELD_DETAIL_SCOPE),
    timeZone: "America/Toronto",
    now: () => now,
    log: () => {}
  }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/integrations/croplink/v2`;
});
after(() => server.close());

const get = (path: string, key = "gki_detail") => fetch(`${base}${path}`, { headers: key ? { "X-Integration-Key": key } : {} });

async function walk(path: string, key = "gki_detail"): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const res = await get(`${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ""}`, key);
    assert.equal(res.status, 200);
    const body = await res.json() as { items: { yieldEntryId: string }[]; nextCursor: string | null; hasMore: boolean };
    ids.push(...body.items.map(i => i.yieldEntryId));
    assert.equal(body.hasMore, body.nextCursor !== null);
    cursor = body.nextCursor;
    pages++;
  } while (cursor);
  return { ids, pages };
}

// ── Authorization ───────────────────────────────────────────────────────────
test("authorization: missing, unknown, wrong-integration, legacy and v1-only keys are refused", async () => {
  rows = [makeRow(1, 10)];
  assert.equal((await get("/yield-weeks", "")).status, 401);
  assert.equal((await get("/yield-weeks", "gki_nope")).status, 401);
  assert.equal((await get("/yield-weeks", "gki_wrongint")).status, 401);
  assert.equal((await get("/yield-weeks", "gki_legacy")).status, 403);
  assert.equal((await get("/yield-weeks", "gki_v1only")).status, 403);
  assert.equal((await get("/yield-week-deletions", "gki_v1only")).status, 403);
  assert.equal((await fetch(`${base}/yield-week-manifests`, { method: "POST", headers: { "X-Integration-Key": "gki_v1only" } })).status, 403);
  assert.equal((await get("/yield-weeks")).status, 200);
});

test("authorization: an organization only ever sees its own rows and manifests", async () => {
  rows = [makeRow(1, 10), makeRow(2, 20, OTHER_ORG)];
  assert.deepEqual((await walk("/yield-weeks", "gki_other")).ids, [uuid(2)]);
  assert.deepEqual((await walk("/yield-weeks")).ids, [uuid(1)]);
  const m = await (await fetch(`${base}/yield-week-manifests`, { method: "POST", headers: { "X-Integration-Key": "gki_detail" } })).json() as { manifestId: string };
  assert.equal((await get(`/yield-week-manifests/${m.manifestId}/ids`, "gki_other")).status, 404);
});

// ── Contract ────────────────────────────────────────────────────────────────
test("contract: response envelope and 400s for bad parameters", async () => {
  rows = [makeRow(1, 10)];
  const body = await (await get("/yield-weeks")).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["hasMore", "items", "nextCursor", "resumeCursor", "serverTime"]);
  for (const bad of ["?limit=0", "?limit=501", "?cursor=zzz", "?updatedAfter=soon", "?year=99"]) {
    assert.equal((await get(`/yield-weeks${bad}`)).status, 400, bad);
  }
});

// ── Pagination ──────────────────────────────────────────────────────────────
test("pagination: 1,203 rows with heavy timestamp ties are each returned exactly once, in order", async () => {
  rows = Array.from({ length: 1203 }, (_, i) => makeRow(i + 1, Math.floor(i / 7))); // 7 rows share every timestamp
  const { ids, pages } = await walk("/yield-weeks");
  assert.equal(ids.length, 1203);
  assert.equal(new Set(ids).size, 1203);
  assert.equal(pages, 3);
  const expected = [...rows].sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id.localeCompare(b.id))).map(r => r.id);
  assert.deepEqual(ids, expected);
});

test("pagination: exactly 500 and 1,000 rows end without an empty extra page", async () => {
  rows = Array.from({ length: 500 }, (_, i) => makeRow(i + 1, i));
  assert.deepEqual([(await walk("/yield-weeks")).pages, (await walk("/yield-weeks")).ids.length], [1, 500]);
  rows = Array.from({ length: 1000 }, (_, i) => makeRow(i + 1, i));
  assert.deepEqual([(await walk("/yield-weeks")).pages, (await walk("/yield-weeks")).ids.length], [2, 1000]);
});

test("pagination: a row edited mid-walk moves behind the cursor and is still delivered (never skipped)", async () => {
  rows = Array.from({ length: 10 }, (_, i) => makeRow(i + 1, i));
  const first = await (await get("/yield-weeks?limit=4")).json() as { items: { yieldEntryId: string }[]; nextCursor: string };
  // An unseen row (#8) and an already-delivered row (#2) are edited now.
  rows.find(r => r.id === uuid(8))!.updated_at = ts(500);
  rows.find(r => r.id === uuid(2))!.updated_at = ts(501);
  const rest: string[] = [];
  let cursor: string | null = first.nextCursor;
  while (cursor) {
    const b = await (await get(`/yield-weeks?limit=4&cursor=${encodeURIComponent(cursor)}`)).json() as { items: { yieldEntryId: string }[]; nextCursor: string | null };
    rest.push(...b.items.map(i => i.yieldEntryId));
    cursor = b.nextCursor;
  }
  const all = [...first.items.map(i => i.yieldEntryId), ...rest];
  for (let n = 1; n <= 10; n++) assert.ok(all.includes(uuid(n)), `row ${n} delivered`);
  assert.deepEqual(rest.slice(-2), [uuid(8), uuid(2)]);
});

test("pagination: updatedAfter returns only rows changed after the watermark", async () => {
  rows = Array.from({ length: 5 }, (_, i) => makeRow(i + 1, i * 60));
  const { ids } = await walk(`/yield-weeks?updatedAfter=${encodeURIComponent(new Date(Date.parse(ts(120))).toISOString())}`);
  assert.deepEqual(ids, [uuid(4), uuid(5)]);
});

// ── Provisional / settled ───────────────────────────────────────────────────
test("settlement: settled week becomes provisional again after a late edit", async () => {
  rows = [makeRow(1, 0, ORG, 36)];
  rows[0].updated_at = "2026-09-08T16:58:10.000000+00:00";
  now = new Date("2026-10-04T12:00:00Z");
  let item = ((await (await get("/yield-weeks")).json()) as { items: { settlement: { status: string } }[] }).items[0];
  assert.equal(item.settlement.status, "settled");
  rows[0].updated_at = "2026-10-04T11:00:00.000000+00:00"; // late edit
  item = ((await (await get("/yield-weeks")).json()) as { items: { settlement: { status: string } }[] }).items[0];
  assert.equal(item.settlement.status, "provisional");
  now = new Date("2026-10-07T11:00:01Z");
  item = ((await (await get("/yield-weeks")).json()) as { items: { settlement: { status: string } }[] }).items[0];
  assert.equal(item.settlement.status, "settled");
  now = new Date("2026-10-04T12:00:00Z");
});

// ── Deletions ───────────────────────────────────────────────────────────────
test("deletions: tombstones page by (deleted_at, id) and stay org-scoped", async () => {
  deletions = Array.from({ length: 7 }, (_, i) => ({ organization_id: i === 6 ? OTHER_ORG : ORG, id: uuid(700 + i), entity_id: uuid(i + 1), variety_id: null, year: 2026, week: 38, deleted_at: ts(Math.floor(i / 2)) }));
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const b = await (await get(`/yield-week-deletions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json() as { items: { yieldEntryId: string; tombstoneId: string }[]; nextCursor: string | null };
    seen.push(...b.items.map(i => i.yieldEntryId));
    cursor = b.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6].map(uuid));
});

// ── Manifests ───────────────────────────────────────────────────────────────
test("manifest: pages reassemble to exactly expectedCount ids matching the checksum, immune to later changes", async () => {
  rows = Array.from({ length: 2345 }, (_, i) => makeRow(i + 1, i));
  const res = await fetch(`${base}/yield-week-manifests`, { method: "POST", headers: { "X-Integration-Key": "gki_detail" } });
  assert.equal(res.status, 201);
  const m = await res.json() as { manifestId: string; expectedCount: number; checksum: string; algorithm: string };
  assert.equal(m.expectedCount, 2345);
  rows = rows.slice(0, 100); // entries deleted after the manifest was taken
  const ids: string[] = [];
  let cursor: string | null = "0";
  while (cursor !== null) {
    const p = await (await get(`/yield-week-manifests/${m.manifestId}/ids?cursor=${cursor}`)).json() as { manifestId: string; checksum: string; expectedCount: number; offset: number; ids: string[]; nextCursor: string | null };
    assert.equal(p.manifestId, m.manifestId);
    assert.equal(p.checksum, m.checksum);
    assert.equal(p.offset, ids.length);
    ids.push(...p.ids);
    cursor = p.nextCursor;
  }
  assert.equal(ids.length, m.expectedCount);
  assert.equal(manifestChecksum(ids), m.checksum);
});

test("manifest: expired → 410, bad cursor → 400, unknown → 404", async () => {
  rows = [makeRow(1, 1)];
  const m = await (await fetch(`${base}/yield-week-manifests`, { method: "POST", headers: { "X-Integration-Key": "gki_detail" } })).json() as { manifestId: string };
  assert.equal((await get(`/yield-week-manifests/${m.manifestId}/ids?cursor=-1`)).status, 400);
  assert.equal((await get(`/yield-week-manifests/${m.manifestId}/ids?cursor=99`)).status, 400);
  assert.equal((await get(`/yield-week-manifests/${uuid(123456)}/ids`)).status, 404);
  now = new Date(now.getTime() + 2 * 3600_000);
  assert.equal((await get(`/yield-week-manifests/${m.manifestId}/ids`)).status, 410);
  now = new Date("2026-10-04T12:00:00Z");
});

test("resumeCursor: resuming after the final page returns only rows that share the last timestamp but sort later, plus newer rows", async () => {
  rows = [makeRow(1, 10), makeRow(2, 10), makeRow(3, 10)];
  const page = await (await get("/yield-weeks?limit=2")).json() as { nextCursor: string; resumeCursor: string };
  const last = await (await get(`/yield-weeks?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)).json() as { items: { yieldEntryId: string }[]; nextCursor: string | null; resumeCursor: string };
  assert.equal(last.nextCursor, null);
  assert.deepEqual(last.items.map(i => i.yieldEntryId), [uuid(3)]);
  rows.push(makeRow(4, 10), makeRow(5, 11)); // same timestamp as the last stored row, larger id; and a newer row
  const resumed = await (await get(`/yield-weeks?cursor=${encodeURIComponent(last.resumeCursor)}`)).json() as { items: { yieldEntryId: string }[]; resumeCursor: string };
  assert.deepEqual(resumed.items.map(i => i.yieldEntryId), [uuid(4), uuid(5)]);
  const empty = await (await get(`/yield-weeks?cursor=${encodeURIComponent(resumed.resumeCursor)}`)).json() as { items: unknown[]; resumeCursor: string };
  assert.deepEqual([empty.items.length, empty.resumeCursor], [0, resumed.resumeCursor]);
});

test("contract: items carry both the variety record area and the measured physical footprint", async () => {
  rows = [makeRow(1, 10)];
  const it = ((await (await get("/yield-weeks")).json()) as { items: Record<string, unknown>[] }).items[0];
  assert.deepEqual([it.varietyAreaM2, it.physicalAreaM2, it.physicalAreaRowCount, it.physicalAreaRowsMissingDimensions], [11627, 11600.5, 40, 0]);
});
