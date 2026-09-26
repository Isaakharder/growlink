// Recent retained CSV sources for the Template Builder: listing, exact
// reload, and organization isolation. Runs fully offline against an
// in-memory fake client (testHelpers/offlineSupabase) — never the live DB.
import "./testHelpers/offlineSupabase";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./testHelpers/offlineSupabase";
import { parseCsvGrid } from "../../utils/csvGridParser";
import { computeFingerprint, computeFingerprintHash } from "../../utils/csvTemplateFingerprint";
import {
  getSourceFileGridAndMatch,
  listRecentSourceFiles,
  TemplateNotFoundError,
  RECENT_SOURCE_MAX_LIMIT,
  type DbClient
} from "../csvMappingTemplates";

const FIXTURES_DIR = join(__dirname, "..", "..", "utils", "__tests__", "fixtures", "flowmaster-csv");
// Real FlowMaster exports: 14 columns with a repeated WEIGHT,AVG,PCS group.
const LOT_2609220442 = readFileSync(join(FIXTURES_DIR, "lot-2609220442.csv"), "utf-8");
const LOT_2608170362 = readFileSync(join(FIXTURES_DIR, "lot-2608170362.csv"), "utf-8");
const OTHER_LAYOUT = "Date,Variety,Kg\n2026-09-01,Cadalora,12.5\n";

const ORG_A = "org-a";
const ORG_B = "org-b";

function fingerprintHash(text: string, headerRowIndex = 0): string {
  const grid = parseCsvGrid(text, ",");
  return computeFingerprintHash(computeFingerprint(grid.rows, ",", headerRowIndex));
}

function sourceRow(id: string, organizationId: string, filename: string, rawText: string, uploadedAt: string) {
  const grid = parseCsvGrid(rawText, ",");
  return {
    id,
    organization_id: organizationId,
    filename,
    raw_text: rawText,
    delimiter: ",",
    row_count: grid.rowCount,
    column_count: grid.columnCount,
    uploaded_at: uploadedAt
  };
}

function templateRow(id: string, organizationId: string, name: string, version: number, hash: string) {
  return {
    id,
    organization_id: organizationId,
    name,
    version,
    is_current: true,
    is_active: true,
    delimiter: ",",
    header_row_index: 0,
    fingerprint: { headers: [] },
    fingerprint_hash: hash
  };
}

function fixtureDb() {
  const flowMasterHash = fingerprintHash(LOT_2609220442);
  return createFakeDb({
    csv_import_source_files: [
      sourceRow("a-newest-other", ORG_A, "weekly.csv", OTHER_LAYOUT, "2026-09-25T10:00:00Z"),
      sourceRow("a-442", ORG_A, "lot-2609220442.csv", LOT_2609220442, "2026-09-22T17:03:48Z"),
      sourceRow("a-362", ORG_A, "lot-2608170362.csv", LOT_2608170362, "2026-08-18T09:00:00Z"),
      sourceRow("a-unqueued", ORG_A, "test-upload.csv", LOT_2608170362 + "\n", "2026-08-01T09:00:00Z"),
      // Another organization's file — newer than everything in org A.
      sourceRow("b-secret", ORG_B, "org-b-lot.csv", LOT_2609220442, "2026-09-26T12:00:00Z")
    ],
    csv_mapping_templates: [
      templateRow("tpl-a", ORG_A, "Latest Mapping", 11, flowMasterHash),
      templateRow("tpl-b", ORG_B, "Org B Mapping", 1, flowMasterHash)
    ],
    agent_pending_imports: [
      { organization_id: ORG_A, source_file_id: "a-442", csv_mapping_template_id: "tpl-a", needs_template: false },
      { organization_id: ORG_A, source_file_id: "a-newest-other", csv_mapping_template_id: null, needs_template: true },
      { organization_id: ORG_B, source_file_id: "b-secret", csv_mapping_template_id: "tpl-b", needs_template: false }
    ],
    yield_import_runs: [
      { organization_id: ORG_A, source_file_id: "a-362", csv_mapping_template_id: "tpl-a" }
    ]
  });
}

test("a retained source reloads with identical headers, cells and duplicate-column positions", async () => {
  const { client } = fixtureDb();
  const reloaded = await getSourceFileGridAndMatch(ORG_A, "a-442", client as DbClient);
  const original = parseCsvGrid(LOT_2609220442, ",");

  assert.equal(reloaded.filename, "lot-2609220442.csv");
  assert.equal(reloaded.uploadedAt, "2026-09-22T17:03:48Z");
  assert.deepEqual(reloaded.grid, original.rows);
  assert.equal(reloaded.columnCount, 14);

  // Both WEIGHT/AVG/PCS groups survive at their exact positions — the
  // mapper distinguishes them only by column index.
  const header = reloaded.grid[0].map((h) => h.trim());
  assert.deepEqual(header.slice(8), ["WEIGHT", "AVG", "PCS", "WEIGHT", "AVG", "PCS"]);
  assert.equal(reloaded.grid[1][10].trim(), "1");
  assert.equal(reloaded.grid[1][13].trim(), "2224");
});

test("a retained source reloads the exact same grid on every load", async () => {
  const { client } = fixtureDb();
  const first = await getSourceFileGridAndMatch(ORG_A, "a-362", client as DbClient);
  const second = await getSourceFileGridAndMatch(ORG_A, "a-362", client as DbClient);
  assert.deepEqual(first.grid, second.grid);
  assert.deepEqual(first.grid, parseCsvGrid(LOT_2608170362, ",").rows);
});

test("users cannot load another organization's source file", async () => {
  const { client } = fixtureDb();
  await assert.rejects(() => getSourceFileGridAndMatch(ORG_A, "b-secret", client as DbClient), TemplateNotFoundError);
});

test("the recent-source list only ever contains the caller's own organization's files", async () => {
  const { client } = fixtureDb();
  const files = await listRecentSourceFiles(ORG_A, {}, client as DbClient);
  assert.deepEqual(
    files.map((f) => f.id),
    ["a-newest-other", "a-442", "a-362", "a-unqueued"]
  );
  assert.ok(!files.some((f) => f.filename === "org-b-lot.csv"));

  const orgBFiles = await listRecentSourceFiles(ORG_B, {}, client as DbClient);
  assert.deepEqual(orgBFiles.map((f) => f.id), ["b-secret"]);
});

test("users cannot check compatibility against another organization's template", async () => {
  const { client } = fixtureDb();
  await assert.rejects(() => listRecentSourceFiles(ORG_A, { templateId: "tpl-b" }, client as DbClient), TemplateNotFoundError);
});

test("the recent-source list reports filename, upload time, import status and template/version", async () => {
  const { client } = fixtureDb();
  const byId = new Map((await listRecentSourceFiles(ORG_A, {}, client as DbClient)).map((f) => [f.id, f]));

  assert.deepEqual(
    { ...byId.get("a-442"), compatible: undefined },
    {
      id: "a-442",
      filename: "lot-2609220442.csv",
      uploadedAt: "2026-09-22T17:03:48Z",
      rowCount: 11,
      columnCount: 14,
      status: "pending",
      templateId: "tpl-a",
      templateName: "Latest Mapping",
      templateVersion: 11,
      compatible: undefined
    }
  );
  assert.equal(byId.get("a-362")?.status, "imported");
  assert.equal(byId.get("a-362")?.templateName, "Latest Mapping");
  assert.equal(byId.get("a-newest-other")?.status, "needs_template");
  assert.equal(byId.get("a-newest-other")?.templateId, null);
  assert.equal(byId.get("a-unqueued")?.status, "not_queued");
  // Compatibility is only evaluated when a template is requested.
  assert.equal(byId.get("a-442")?.compatible, null);
});

test("compatibility against a template: the most recent compatible source is the newest matching layout", async () => {
  const { client } = fixtureDb();
  const files = await listRecentSourceFiles(ORG_A, { templateId: "tpl-a" }, client as DbClient);
  const compatible = files.filter((f) => f.compatible);

  assert.equal(files.find((f) => f.id === "a-newest-other")?.compatible, false);
  assert.deepEqual(compatible.map((f) => f.id), ["a-442", "a-362", "a-unqueued"]);
  assert.equal(compatible[0].filename, "lot-2609220442.csv");
});

test("the recent-source list limit is clamped", async () => {
  const { client } = fixtureDb();
  assert.equal((await listRecentSourceFiles(ORG_A, { limit: 2 }, client as DbClient)).length, 2);
  assert.equal((await listRecentSourceFiles(ORG_A, { limit: 0 }, client as DbClient)).length, 1);
  assert.ok(RECENT_SOURCE_MAX_LIMIT <= 100);
});
