// Route-order regression for csvMappingTemplatesRouter: literal sibling
// paths under /csv-templates (source-files, pending) must reach their own
// handlers and never be captured by GET /csv-templates/:id as a template id.
// Before this fix, GET /csv-templates/source-files was registered after
// /:id, so "source-files" went to getTemplateById and returned a 500.
//
// Real HTTP through the real router and permission middleware; the shared
// Supabase client's from() is pointed at an in-memory fake, so this runs
// fully offline and records every query it makes.
import "./testHelpers/offlineSupabase";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createFakeDb } from "./testHelpers/offlineSupabase";
import { supabase } from "../../config/supabase";
import { csvMappingTemplatesRouter } from "../csvMappingTemplates";

const ORG = "org-route-order";
const USER = "user-route-order";
const VIEWER = "viewer-route-order";
const SOURCE_ID = "5b3c1d2e-0000-4000-8000-000000000001";
const TEMPLATE_ID = "5b3c1d2e-0000-4000-8000-0000000000aa";

const fake = createFakeDb({
  memberships: [
    { user_id: USER, organization_id: ORG, role: "owner", permissions: {} },
    { user_id: VIEWER, organization_id: ORG, role: "member", permissions: { "yield:view": true } }
  ],
  csv_import_source_files: [
    {
      id: SOURCE_ID,
      organization_id: ORG,
      filename: "lot-2609220442.csv",
      raw_text: "LOTNUMBER,WEIGHT,AVG,PCS,WEIGHT,AVG,PCS\n2609220442,13.138,117.3,112,427.618,192.3,2224\n",
      delimiter: ",",
      row_count: 2,
      column_count: 7,
      uploaded_at: "2026-09-22T17:03:48Z"
    }
  ],
  csv_mapping_templates: [],
  agent_pending_imports: [],
  yield_import_runs: []
});

// Point the shared client (used by the router's default db and by
// requirePermission's membership lookup) at the fake, and restore it after.
const realFrom = supabase.from.bind(supabase);
(supabase as unknown as { from: unknown }).from = fake.from;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.userId = req.get("x-test-user") ?? USER;
  req.organizationId = ORG;
  next();
});
app.use("/api", csvMappingTemplatesRouter);

let server: Server;
const ready = new Promise<string>((resolve) => {
  server = app.listen(0, () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
});

after(() => {
  (supabase as unknown as { from: unknown }).from = realFrom;
  server.close();
});

/** Template-detail lookups: a csv_mapping_templates query filtered by id. */
function templateIdLookups(): unknown[] {
  return fake.queries
    .filter((q) => q.table === "csv_mapping_templates")
    .flatMap((q) => q.eq.filter(([column]) => column === "id").map(([, value]) => value));
}

test("GET /csv-templates/source-files reaches the source-file list handler, never the template-detail query", async () => {
  const base = await ready;
  fake.queries.length = 0;

  const res = await fetch(`${base}/api/csv-templates/source-files?limit=10`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { files: Array<{ id: string; filename: string }> };
  assert.deepEqual(body.files.map((f) => f.filename), ["lot-2609220442.csv"]);

  assert.ok(fake.queries.some((q) => q.table === "csv_import_source_files"), "the source-file handler ran");
  assert.ok(!templateIdLookups().includes("source-files"), '"source-files" was passed to the template-detail query');
  assert.deepEqual(templateIdLookups(), []);
});

test("GET /csv-templates/source-files/:id/grid reaches the grid handler", async () => {
  const base = await ready;
  fake.queries.length = 0;

  const res = await fetch(`${base}/api/csv-templates/source-files/${SOURCE_ID}/grid`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { filename: string; grid: string[][] };
  assert.equal(body.filename, "lot-2609220442.csv");
  assert.deepEqual(body.grid[0], ["LOTNUMBER", "WEIGHT", "AVG", "PCS", "WEIGHT", "AVG", "PCS"]);
  assert.ok(!templateIdLookups().includes("source-files"));
});

test("a non-UUID template id never reaches the template-detail query (404, no lookup)", async () => {
  const base = await ready;
  fake.queries.length = 0;

  for (const path of ["not-a-uuid", "source-files-x", "12345"]) {
    const res = await fetch(`${base}/api/csv-templates/${path}`);
    assert.equal(res.status, 404, path);
  }
  const put = await fetch(`${base}/api/csv-templates/source-files`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(put.status, 404);
  const del = await fetch(`${base}/api/csv-templates/source-files`, { method: "DELETE" });
  assert.equal(del.status, 404);

  assert.deepEqual(templateIdLookups(), []);
});

test("a malformed source-file id is a 404, not a database error", async () => {
  const base = await ready;
  fake.queries.length = 0;
  const res = await fetch(`${base}/api/csv-templates/source-files/not-a-uuid/grid`);
  assert.equal(res.status, 404);
  assert.ok(!fake.queries.some((q) => q.table === "csv_import_source_files"));
});

test("a valid UUID still reaches the template-detail handler", async () => {
  const base = await ready;
  fake.queries.length = 0;
  const res = await fetch(`${base}/api/csv-templates/${TEMPLATE_ID}`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { message: "Template not found." });
  assert.deepEqual(templateIdLookups(), [TEMPLATE_ID]);
});

test("GET /csv-templates/pending still reaches the pending handler", async () => {
  const base = await ready;
  fake.queries.length = 0;
  const res = await fetch(`${base}/api/csv-templates/pending`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { files: [] });
  assert.ok(!templateIdLookups().includes("pending"));
});

test("GET /csv-templates/pending/reprocess-plan reaches the reprocess handler as a dry run, never the template-detail query", async () => {
  const base = await ready;
  fake.queries.length = 0;
  const res = await fetch(`${base}/api/csv-templates/pending/reprocess-plan`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { dryRun: boolean; total: number };
  assert.deepEqual({ dryRun: body.dryRun, total: body.total }, { dryRun: true, total: 0 });
  assert.ok(fake.queries.some((q) => q.table === "agent_pending_imports"));
  assert.deepEqual(templateIdLookups(), []);
});

test("POST /csv-templates/pending/reprocess reaches the reprocess handler, never the template-detail query", async () => {
  const base = await ready;
  fake.queries.length = 0;
  const res = await fetch(`${base}/api/csv-templates/pending/reprocess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { dryRun: boolean; total: number };
  assert.deepEqual({ dryRun: body.dryRun, total: body.total }, { dryRun: false, total: 0 });
  assert.deepEqual(templateIdLookups(), []);
});

test("reprocessing requires yield:edit — a view-only member is refused before any pending data is read", async () => {
  const base = await ready;
  fake.queries.length = 0;
  const headers = { "Content-Type": "application/json", "x-test-user": VIEWER };
  const post = await fetch(`${base}/api/csv-templates/pending/reprocess`, { method: "POST", headers, body: "{}" });
  assert.equal(post.status, 403);
  const plan = await fetch(`${base}/api/csv-templates/pending/reprocess-plan`, { headers });
  assert.equal(plan.status, 403);
  assert.ok(!fake.queries.some((q) => q.table === "agent_pending_imports"));
});

test("reprocess rejects non-UUID pending ids with a 400", async () => {
  const base = await ready;
  const res = await fetch(`${base}/api/csv-templates/pending/reprocess`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pendingImportIds: ["source-files"] })
  });
  assert.equal(res.status, 400);
});
