// Remembered pack measurements ("Remember for future weeks") end to end over
// HTTP: the real pack-shipments, manual-entry and integrations routers and
// permission middleware, on a real Postgres (PGlite) with migrations
// 0143-0146 applied. DockLink's export is the mock fixture (pack scope
// 2026-W45..W48). No server, Docker, network or credentials.
// Run: node --require tsx/cjs --test src/routes/__tests__/packMeasurementDefaults.http.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { readFileSync } from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteSupabase } from "./testHelpers/pgliteSupabase";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const DL_ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DL_OTHER_ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const VIEWER = "aaaaaaaa-0000-4000-8000-00000000000b";
const RED = "a3f00000-0000-4000-8000-000000000001";
const TRI = "d91b0000-0000-4000-8000-000000000004";
const RED_KEY = `docklink:${RED}|single|red|pepper|kg`;
const TRI_KEY = `docklink:${TRI}|mixed|mixed|pepper|kg`;

const migrations = ["0143_docklink_pack_shipments.sql", "0144_manual_pack_case_entries.sql", "0145_case_rebuild_ranges.sql", "0146_pack_measurement_defaults.sql"].map(
  (f) => readFileSync(path.resolve(__dirname, "../../../../supabase/migrations", f), "utf8")
);
const fixture = () => JSON.parse(readFileSync(path.resolve(__dirname, "../../lib/__tests__/fixtures/docklink-pack-export-v1.json"), "utf8"));

let db: PGlite;
let server: Server;
let baseUrl: string;

async function resetDatabase() {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations (id uuid primary key);
    insert into organizations values ('${ORG}'), ('${OTHER_ORG}');
    create table memberships (user_id uuid, organization_id uuid, role text, permissions jsonb);
    insert into memberships values
      ('${OWNER}', '${ORG}', 'owner', '{}'), ('${OWNER}', '${OTHER_ORG}', 'owner', '{}'),
      ('${VIEWER}', '${ORG}', 'member', '{"cases:view": true}');
    create table organization_integrations (organization_id uuid, integration_name text, external_organization_id text, enabled boolean);
    insert into organization_integrations values ('${ORG}', 'docklink', '${DL_ORG}', true), ('${OTHER_ORG}', 'docklink', '${DL_OTHER_ORG}', true);
    create table color_case_entries (
      id uuid primary key default gen_random_uuid(), organization_id uuid not null, color text not null, year int not null, week int not null,
      total_cases numeric not null, case_weight_kg numeric not null, total_kg numeric not null default 0, kg_per_m2 numeric not null default 0,
      color_area_m2 numeric not null default 0, source text default 'manual', synced_at timestamptz, source_summary jsonb,
      created_at timestamptz default now(), updated_at timestamptz default now(), unique (organization_id, color, year, week));
    insert into color_case_entries (organization_id, color, year, week, total_cases, case_weight_kg, total_kg, source) values
      ('${ORG}', 'red', 2026, 20, 900, 5.15, 4635, 'docklink');   -- inside the rebuild range: kept, not counted
  `);
  for (const m of migrations) await db.exec(m);
  // The owner's rebuild range (as in production: 2026-W16..W43).
  await db.query(
    `insert into case_rebuild_ranges (organization_id, from_iso_year, from_iso_week, to_iso_year, to_iso_week, note) values ($1, 2026, 16, 2026, 43, 'rebuild')`,
    [ORG]
  );
}

before(async () => {
  process.env.DOCKLINK_SUPABASE_URL = "https://docklink.test";
  process.env.DOCKLINK_SUPABASE_SERVICE_ROLE_KEY = "test-key";
  await resetDatabase();
  const growlinkClient = new Proxy({}, { get: (_t, prop) => (createPgliteSupabase(db) as Record<string | symbol, unknown>)[prop] });
  const docklinkClient = {
    // The same export for either organization (same pack ids), addressed to the DockLink organization asked for.
    rpc: async (_fn: string, args: { p_organization_id: string }) => ({ data: { ...fixture(), organization_id: args.p_organization_id }, error: null }),
    from: () => {
      throw new Error("the pack sync must not read DockLink tables directly");
    }
  };
  const stub = (p: string, exports: Record<string, unknown>) => {
    const id = require.resolve(p);
    require.cache[id] = { id, filename: id, loaded: true, exports } as unknown as NodeJS.Module;
  };
  stub("../../config/supabase", { supabase: growlinkClient });
  stub("../../config/docklink", { docklinkSupabase: docklinkClient, isDocklinkConfigured: () => true });
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { integrationsRouter } = require("../integrations") as typeof import("../integrations");
  const { packShipmentsRouter } = require("../packShipments") as typeof import("../packShipments");
  const { manualPackEntriesRouter } = require("../manualPackEntries") as typeof import("../manualPackEntries");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = String(req.headers["x-test-user"] ?? OWNER);
    req.organizationId = String(req.headers["x-test-org"] ?? ORG);
    next();
  });
  app.use("/api", integrationsRouter);
  app.use("/api", packShipmentsRouter);
  app.use("/api", manualPackEntriesRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

beforeEach(resetDatabase);

type Opts = { user?: string; org?: string; body?: unknown; method?: string };
async function call(pathname: string, { user = OWNER, org = ORG, body, method }: Opts = {}) {
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-test-user": user, "x-test-org": org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}
const sync = (o: Opts = {}) => call("/integrations/docklink/sync-packs", { ...o, method: "POST" });
const week = (w: number, o: Opts = {}) => call(`/pack-shipments/week?isoYear=2026&isoWeek=${w}`, o);
const add = (w: number, packId: string, cases: number, o: Opts = {}) =>
  call("/manual-pack-entries", { ...o, method: "POST", body: { isoYear: 2026, isoWeek: w, lines: [{ packSource: "docklink", packId, cases }], confirmDuplicates: true } });
const measure = (w: number, key: string, values: Record<string, unknown>, o: Opts = {}) =>
  call("/pack-shipments/measurements", { ...o, method: "PUT", body: { isoYear: 2026, isoWeek: w, measurementKey: key, ...values } });
const clearMeasurement = (w: number, key: string) =>
  call(`/pack-shipments/measurements?isoYear=2026&isoWeek=${w}&measurementKey=${encodeURIComponent(key)}`, { method: "DELETE" });
const remember = (w: number, key: string, values: Record<string, unknown>, o: Opts = {}) =>
  call("/pack-shipments/measurement-defaults", { ...o, method: "PUT", body: { isoYear: 2026, isoWeek: w, measurementKey: key, ...values } });
const forget = (w: number, key: string, valueKind: string, o: Opts = {}) =>
  call(`/pack-shipments/measurement-defaults?isoYear=2026&isoWeek=${w}&measurementKey=${encodeURIComponent(key)}&valueKind=${valueKind}`, { ...o, method: "DELETE" });
const yieldRange = (from: number, to: number, o: Opts = {}) => call(`/shipped-yield?fromYear=2026&fromWeek=${from}&toYear=2026&toWeek=${to}`, o);
const pack = (w: Record<string, any>, id: string) => w.packs.find((p: any) => p.packId === id);
const close = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`);
const snapshot = async () =>
  JSON.stringify(
    await Promise.all(
      ["pack_case_measurements", "manual_pack_case_entries", "case_rebuild_ranges", "case_week_sources", "case_week_confirmations", "color_case_entries"].map(
        async (t) => (await db.query(`select * from ${t} order by 1, 2, 3`)).rows
      )
    )
  );
const defaultsCount = async (org = ORG) =>
  (await db.query<{ n: number }>(`select count(*)::int n from pack_measurement_defaults where organization_id = $1`, [org])).rows[0].n;

// ---------------------------------------------------------------------------

test("remembering applies to this and later weeks without their own measurement, for manual and imported cases; labelled remembered", async () => {
  assert.equal((await sync()).status, 200);
  for (const w of [29, 30, 31, 35]) assert.equal((await add(w, RED, 100)).status, 201);

  let w30 = (await week(30)).body;
  assert.equal(pack(w30, RED).status, "missing");
  const saved = await remember(30, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.remembered.netKgPerCase, { value: 5, from: { isoYear: 2026, isoWeek: 30 }, nextChange: null });
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from pack_case_measurements`)).rows[0].n, 0, "remembering writes no week measurement");

  w30 = (await week(30)).body;
  const red30 = pack(w30, RED);
  assert.equal(red30.status, "remembered");
  assert.equal(red30.measurement, null, "the week has no measurement of its own");
  assert.equal(red30.remembered.netKgPerCase.value, 5);
  close(red30.kg, 500);
  assert.equal(w30.totals.rememberedCases, 100);
  assert.equal(w30.totals.complete, true);
  close((await week(35)).body.totals.kg, 500);
  // The week before stays as it was.
  assert.equal(pack((await week(29)).body, RED).status, "missing");
  // Imported DockLink weeks (W46: 1720 Red 5kg cases) use the same remembered weight.
  const w46 = (await week(46)).body;
  assert.equal(w46.source, "packs");
  assert.equal(pack(w46, RED).status, "remembered");
  close(pack(w46, RED).kg, 1720 * 5);

  // /shipped-yield agrees with the week screen.
  const y = (await yieldRange(29, 31)).body;
  assert.deepEqual(y.weeks.find((x: any) => x.isoWeek === 30), w30.totals);
  close(y.weeks.find((x: any) => x.isoWeek === 29).kg, 0);
  assert.equal(y.weeks.find((x: any) => x.isoWeek === 29).unmeasuredCases, 100);
  assert.equal(y.totals.rememberedCases, 200);
});

test("Save is for the selected week only: it overrides the remembered weight there, and Clear returns to it", async () => {
  await sync();
  for (const w of [30, 31, 32]) await add(w, RED, 100);
  await remember(30, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5 });
  const before = await db.query(`select * from pack_measurement_defaults`);

  assert.equal((await measure(31, RED_KEY, { netKgPerCase: 6 })).status, 200);
  const w31 = (await week(31)).body;
  assert.equal(pack(w31, RED).status, "measured");
  assert.equal(pack(w31, RED).measurement.netKgPerCase, 6);
  assert.equal(pack(w31, RED).remembered.netKgPerCase.value, 5, "the remembered weight is still shown");
  close(w31.totals.kg, 600);
  assert.equal(w31.totals.rememberedCases, 0);
  close((await week(32)).body.totals.kg, 500, "later weeks keep the remembered weight");
  assert.deepEqual((await db.query(`select * from pack_measurement_defaults`)).rows, before.rows, "the default is untouched");

  assert.equal((await clearMeasurement(31, RED_KEY)).status, 204);
  assert.equal(pack((await week(31)).body, RED).status, "remembered");
  close((await week(31)).body.totals.kg, 500);
});

test("changing or forgetting never recalculates earlier weeks or overwrites existing measurements", async () => {
  await sync();
  for (const w of [20, 25, 30, 35, 40]) await add(w, RED, 10);
  await measure(35, RED_KEY, { netKgPerCase: 9 }); // an existing week measurement
  await remember(20, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5 });
  const kgOf = async (w: number) => (await week(w)).body.totals.kg as number;
  const measurementsBefore = (await db.query(`select * from pack_case_measurements order by iso_week`)).rows;

  // Change from W30.
  assert.equal((await remember(30, RED_KEY, { valueKind: "net_kg", netKgPerCase: 6 })).status, 200);
  close(await kgOf(20), 50);
  close(await kgOf(25), 50, "an earlier week keeps the value it used");
  close(await kgOf(30), 60);
  close(await kgOf(35), 90, "the week's own measurement wins");
  close(await kgOf(40), 60);
  let w25 = pack((await week(25)).body, RED).remembered.netKgPerCase;
  assert.deepEqual(w25, { value: 5, from: { isoYear: 2026, isoWeek: 20 }, nextChange: { isoYear: 2026, isoWeek: 30 } });

  // Changing an earlier week's version only reaches until the later change.
  await remember(25, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5.5 });
  close(await kgOf(20), 50);
  close(await kgOf(25), 55);
  close(await kgOf(30), 60, "the later version still takes over");

  // Forget from W40: W40 is missing again; everything before keeps its value.
  assert.equal((await forget(40, RED_KEY, "net_kg")).status, 204);
  const w40 = (await week(40)).body;
  assert.equal(pack(w40, RED).status, "missing");
  assert.equal(pack(w40, RED).remembered.netKgPerCase.value, null);
  assert.equal(w40.totals.complete, false);
  close(await kgOf(30), 60);
  close(await kgOf(20), 50);
  w25 = pack((await week(25)).body, RED).remembered.netKgPerCase;
  assert.equal(w25.value, 5.5);

  assert.deepEqual((await db.query(`select * from pack_case_measurements order by iso_week`)).rows, measurementsBefore, "week measurements untouched");
  const versions = (await db.query<{ w: number; v: string | null; f: boolean }>(
    `select effective_from_iso_week w, net_kg_per_case::text v, forgotten f from pack_measurement_defaults order by 1`
  )).rows;
  assert.deepEqual(versions, [{ w: 20, v: "5", f: false }, { w: 25, v: "5.5", f: false }, { w: 30, v: "6", f: false }, { w: 40, v: null, f: true }]);

  // Forgetting when nothing is in effect writes nothing.
  assert.equal((await forget(41, RED_KEY, "net_kg")).status, 404, "no Red entries in W41: nothing to forget for");
  await add(42, RED, 1);
  assert.equal((await forget(42, RED_KEY, "net_kg")).status, 204);
  assert.equal(await defaultsCount(), 4);
});

test("rainbow packs remember peppers per case and fruit weights separately", async () => {
  await sync();
  for (const w of [20, 21, 22]) await add(w, TRI, 10);
  const counts = [{ color: "red", piecesPerCase: 5 }, { color: "yellow", piecesPerCase: 5 }, { color: "orange", piecesPerCase: 5 }];
  assert.equal((await remember(20, TRI_KEY, { valueKind: "counts", counts })).status, 200);

  let tri = pack((await week(21)).body, TRI);
  assert.equal(tri.status, "missing", "counts alone don't give kg (fruit weights change)");
  assert.deepEqual(tri.remembered.counts.value, counts);
  assert.equal(tri.remembered.fruitWeights.value, null);

  // This week's own measurement (Save) with the remembered counts and this week's fruit weights.
  const week21 = counts.map((c, i) => ({ ...c, fruitWeightG: [200, 180, 170][i] }));
  assert.equal((await measure(21, TRI_KEY, { components: week21 })).status, 200);
  tri = pack((await week(21)).body, TRI);
  assert.equal(tri.status, "measured");
  close(tri.kgByColor.red, (10 * 5 * 200) / 1000);

  // Fruit weights remembered from W22: W22 gets kg; W21 keeps its own measurement; W20 is still missing.
  const weights = [{ color: "red", fruitWeightG: 210 }, { color: "yellow", fruitWeightG: 190 }, { color: "orange", fruitWeightG: 160 }];
  assert.equal((await remember(22, TRI_KEY, { valueKind: "fruit_weights", fruitWeights: weights })).status, 200);
  const w22 = (await week(22)).body;
  assert.equal(pack(w22, TRI).status, "remembered");
  close(w22.totals.colors.red.kg, 10.5);
  close(w22.totals.colors.yellow.kg, 9.5);
  close(w22.totals.colors.orange.kg, 8);
  assert.equal(w22.totals.mixedCases, 10);
  assert.equal(pack((await week(21)).body, TRI).status, "measured");
  assert.equal(pack((await week(20)).body, TRI).status, "missing");

  // Forget fruit weights from W22: counts stay remembered.
  assert.equal((await forget(22, TRI_KEY, "fruit_weights")).status, 204);
  tri = pack((await week(22)).body, TRI);
  assert.equal(tri.status, "missing");
  assert.deepEqual(tri.remembered.counts.value, counts);

  // Validation: the kind must fit the classification; values must be positive and per colour.
  assert.equal((await remember(22, TRI_KEY, { valueKind: "net_kg", netKgPerCase: 5 })).status, 400);
  assert.equal((await remember(22, TRI_KEY, { valueKind: "counts", counts: [{ color: "red", piecesPerCase: 0 }] })).status, 400);
  assert.equal((await remember(22, TRI_KEY, { valueKind: "counts", counts: [{ color: "pink", piecesPerCase: 3 }] })).status, 400);
  assert.equal((await remember(22, TRI_KEY, { valueKind: "fruit_weights", counts })).status, 400);
  await add(22, RED, 5);
  assert.equal((await remember(22, RED_KEY, { valueKind: "counts", counts })).status, 400);
  assert.equal((await remember(22, RED_KEY, { valueKind: "net_kg", netKgPerCase: -1 })).status, 400);
});

test("remembering preserves case entries, measurements, rebuild ranges and colour totals", async () => {
  await sync();
  for (const w of [20, 30]) await add(w, RED, 100);
  await measure(20, RED_KEY, { netKgPerCase: 4.9 });
  const before = await snapshot();
  await remember(20, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5 });
  await remember(30, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5.1 });
  await forget(30, RED_KEY, "net_kg");
  assert.equal(await snapshot(), before);
  // W20 keeps its own measurement; the colour totals inside the rebuild range still don't count.
  const w20 = (await week(20)).body;
  close(w20.totals.kg, 490);
  assert.equal(w20.notCounted.legacyCases, 900);
});

test("organization isolation and permissions", async () => {
  await sync();
  await sync({ org: OTHER_ORG });
  await add(30, RED, 100);
  await add(30, RED, 100, { org: OTHER_ORG });
  await remember(30, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5 });

  // Same pack id and week in another organization: nothing remembered there.
  const other = (await week(30, { org: OTHER_ORG })).body;
  assert.equal(pack(other, RED).status, "missing");
  assert.equal(pack(other, RED).remembered.netKgPerCase.value, null);
  assert.equal((await yieldRange(30, 30, { org: OTHER_ORG })).body.totals.rememberedCases, 0);

  // The other organization's changes stay in that organization.
  assert.equal((await remember(30, RED_KEY, { valueKind: "net_kg", netKgPerCase: 7 }, { org: OTHER_ORG })).status, 200);
  assert.equal((await forget(30, RED_KEY, "net_kg", { org: OTHER_ORG })).status, 204);
  assert.equal(pack((await week(30)).body, RED).remembered.netKgPerCase.value, 5);
  close((await week(30)).body.totals.kg, 500);
  assert.equal(await defaultsCount(ORG), 1);
  assert.equal(await defaultsCount(OTHER_ORG), 1, "forgetting in the week it was remembered turns that version into a tombstone");
  assert.equal((await db.query<{ forgotten: boolean }>(`select forgotten from pack_measurement_defaults where organization_id = $1`, [OTHER_ORG])).rows[0].forgotten, true);

  // A week with no matching row in the caller's organization can't be remembered.
  assert.equal((await remember(31, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5 })).status, 404);

  // View-only members can see remembered values but not change them.
  const viewer = { user: VIEWER };
  assert.equal(pack((await week(30, viewer)).body, RED).status, "remembered");
  assert.equal((await remember(30, RED_KEY, { valueKind: "net_kg", netKgPerCase: 9 }, viewer)).status, 403);
  assert.equal((await forget(30, RED_KEY, "net_kg", viewer)).status, 403);
  assert.equal(pack((await week(30)).body, RED).remembered.netKgPerCase.value, 5);
});

test("before migration 0146 is applied, weeks and totals read as without remembered measurements; remembering fails loudly", async () => {
  await sync();
  await add(30, RED, 100);
  await measure(30, RED_KEY, { netKgPerCase: 5 });
  await db.exec(`drop table pack_measurement_defaults`);
  const w = await week(30);
  assert.equal(w.status, 200);
  assert.equal(pack(w.body, RED).status, "measured");
  close(w.body.totals.kg, 500);
  assert.equal((await yieldRange(30, 30)).status, 200);
  assert.equal((await remember(30, RED_KEY, { valueKind: "net_kg", netKgPerCase: 5 })).status, 500);
});
