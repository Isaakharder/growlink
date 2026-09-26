// Bulk / per-card reprocessing of pending CSV-template sources against the
// organization's current templates. Reproduces the live situation: every
// pending row still pins "Latest Mapping" v11 (AFW/PCS on the lot-total
// columns 12/13, Pack Date YYYY-MM-DD) after the corrected v13 (9/10,
// DDMMYYYY) was saved — so Refresh kept rendering v11.
//
// Runs the REAL functions (weekly cards, buildCsvPreview, reprocessing)
// with the shared Supabase client's from() pointed at an in-memory fake
// that records every write. Fully offline.
import "./testHelpers/offlineSupabase";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./testHelpers/offlineSupabase";
import { supabase } from "../../config/supabase";
import { parseCsvGrid } from "../../utils/csvGridParser";
import { computeFingerprint, computeFingerprintHash } from "../../utils/csvTemplateFingerprint";
import type { ColumnMapping, ValueMapping } from "../../utils/csvTemplateTypes";
import {
  listPendingCsvTemplateWeeklyCards,
  reprocessPendingCsvSources,
  parseReprocessBody,
  TemplateValidationError,
  REPROCESS_CONCURRENCY
} from "../csvMappingTemplates";

const FIXTURES_DIR = join(__dirname, "..", "..", "utils", "__tests__", "fixtures", "flowmaster-csv");
// The real retained lot-2609220442.csv (byte-identical to the upload).
const LOT_442 = readFileSync(join(FIXTURES_DIR, "lot-2609220442.csv"), "utf-8");
const HEADER_LINE = LOT_442.split("\n")[0];
// A second lot, same variety and ISO week, same layout: 150 kg / 700 pcs in the per-size group.
const LOT_443 = [
  HEADER_LINE,
  "2609220443,1,0699,22092026,22092026,Class 1,LG,null,100.000,200.0,500,150.000,187.5,800",
  "2609220443,1,0699,22092026,22092026,Class 1,XL,null,50.000,250.0,200,150.000,187.5,800",
  ""
].join("\n");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const V11 = "aaaaaaaa-0000-4000-8000-000000000011";
const V13 = "aaaaaaaa-0000-4000-8000-000000000013";
const OTHER_ORG_TEMPLATE = "bbbbbbbb-0000-4000-8000-000000000001";

const SRC_442 = "cccccccc-0000-4000-8000-000000000442";
const SRC_443 = "cccccccc-0000-4000-8000-000000000443";
const SRC_IMPORTED = "cccccccc-0000-4000-8000-000000000999";
const SRC_MISSING = "cccccccc-0000-4000-8000-00000000dead";
const SRC_OTHER_ORG = "cccccccc-0000-4000-8000-0000000000b0";

const P_442 = "dddddddd-0000-4000-8000-000000000442";
const P_443 = "dddddddd-0000-4000-8000-000000000443";
const P_IMPORTED = "dddddddd-0000-4000-8000-000000000999";
const P_MISSING = "dddddddd-0000-4000-8000-00000000dead";
const P_OTHER_ORG = "dddddddd-0000-4000-8000-0000000000b0";

const fingerprint = computeFingerprint(parseCsvGrid(LOT_442, ",").rows, ",", 0);
const FINGERPRINT_HASH = computeFingerprintHash(fingerprint);

const SIZES = { SM: "size-sm", MD: "size-md", LG: "size-lg", SXL: "size-sxl", XL: "size-xl", XXL: "size-xxl" };
const VALUE_MAPPINGS: ValueMapping[] = [
  ...Object.entries(SIZES).map(([raw, id]) => ({ sourceField: "size_label" as const, rawValue: raw, action: "map" as const, targetSizeId: id })),
  ...["underweight", "Doubles", "{undersized}", "{oversized}"].map((raw) => ({ sourceField: "size_label" as const, rawValue: raw, action: "ignore" as const }))
];

function mappings(afwCol: number, pcsCol: number, dateFormat: "YYYY-MM-DD" | "DDMMYYYY"): ColumnMapping[] {
  return [
    { columnIndex: 2, field: "variety" },
    { columnIndex: 3, field: "packed_date", dateFormat },
    { columnIndex: 0, field: "lot_number" },
    { columnIndex: 6, field: "size_label" },
    { columnIndex: 8, field: "size_weight_kg" },
    { columnIndex: afwCol, field: "average_fruit_weight_g" },
    { columnIndex: 1, field: "run_number" },
    { columnIndex: pcsCol, field: "piece_count" }
  ];
}

function template(id: string, organizationId: string, version: number, isCurrent: boolean, columnMappings: ColumnMapping[]) {
  return {
    id,
    template_group_id: "grp-latest",
    organization_id: organizationId,
    name: "Latest Mapping",
    version,
    is_current: isCurrent,
    is_active: true,
    delimiter: ",",
    encoding: "utf-8",
    header_row_index: 0,
    data_start_row_index: 1,
    data_end_row_index: null,
    skip_row_indexes: [],
    blank_row_behavior: "skip",
    fingerprint,
    fingerprint_hash: FINGERPRINT_HASH,
    column_mappings: columnMappings,
    fixed_cell_mappings: [],
    value_mappings: VALUE_MAPPINGS,
    rules: [],
    created_by: "user-1",
    updated_by: "user-1",
    created_at: "2026-09-26T14:47:46Z",
    updated_at: "2026-09-26T16:14:33Z"
  };
}

function source(id: string, organizationId: string, filename: string, rawText: string) {
  return { id, organization_id: organizationId, filename, raw_text: rawText, delimiter: ",", row_count: 0, column_count: 14, uploaded_at: "2026-09-22T17:03:48Z" };
}

function pending(id: string, organizationId: string, filename: string, sourceFileId: string | null, templateId: string | null, uploadedAt: string) {
  return {
    id,
    organization_id: organizationId,
    source_filename: filename,
    source_file_id: sourceFileId,
    data_source_type: "csv_template",
    csv_mapping_template_id: templateId,
    needs_template: false,
    uploaded_at: uploadedAt
  };
}

/** The live situation: v13 is current, every pending row still pins v11. */
function liveLikeDb() {
  return createFakeDb({
    csv_mapping_templates: [
      template(V11, ORG, 11, false, mappings(12, 13, "YYYY-MM-DD")),
      template(V13, ORG, 13, true, mappings(9, 10, "DDMMYYYY")),
      { ...template(OTHER_ORG_TEMPLATE, OTHER_ORG, 1, true, mappings(9, 10, "DDMMYYYY")), name: "Other Org Mapping" }
    ],
    csv_import_source_files: [
      source(SRC_442, ORG, "lot-2609220442.csv", LOT_442),
      source(SRC_443, ORG, "lot-2609220443.csv", LOT_443),
      source(SRC_IMPORTED, ORG, "lot-2609220999.csv", LOT_443.replace(/2609220443/g, "2609220999")),
      source(SRC_OTHER_ORG, OTHER_ORG, "org-b.csv", LOT_442)
    ],
    agent_pending_imports: [
      pending(P_442, ORG, "lot-2609220442.csv", SRC_442, V11, "2026-09-26T10:43:50Z"),
      pending(P_443, ORG, "lot-2609220443.csv", SRC_443, V11, "2026-09-26T10:43:49Z"),
      // Stray pending row whose source was already imported — must be skipped.
      pending(P_IMPORTED, ORG, "lot-2609220999.csv", SRC_IMPORTED, V11, "2026-09-26T10:43:48Z"),
      pending(P_OTHER_ORG, OTHER_ORG, "org-b.csv", SRC_OTHER_ORG, OTHER_ORG_TEMPLATE, "2026-09-26T10:43:47Z")
    ],
    yield_import_runs: [
      { id: "run-1", organization_id: ORG, lot_number: "2609220999", source_file_id: SRC_IMPORTED, csv_mapping_template_id: V11 }
    ],
    yield_entries: [],
    yield_entry_daily_breakdown: [],
    csv_source_value_overrides: [],
    yield_sizes: [
      { id: SIZES.SM, organization_id: ORG, name: "Small" },
      { id: SIZES.MD, organization_id: ORG, name: "Medium" },
      { id: SIZES.LG, organization_id: ORG, name: "Large" },
      { id: SIZES.SXL, organization_id: ORG, name: "SXL" },
      { id: SIZES.XL, organization_id: ORG, name: "XL" },
      { id: SIZES.XXL, organization_id: ORG, name: "XXL" }
    ],
    varieties: [{ id: "variety-0699", organization_id: ORG, name: "0699", status: "active", area_m2: 14600 }]
  });
}

type Fake = ReturnType<typeof liveLikeDb>;
const realFrom = supabase.from.bind(supabase);
function useFake(fake: Fake) {
  (supabase as unknown as { from: unknown }).from = fake.from;
}
afterEach(() => {
  (supabase as unknown as { from: unknown }).from = realFrom;
});

const pendingRow = (fake: Fake, id: string) => fake.tables.agent_pending_imports.find((r) => r.id === id)!;
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
/** The card holding lot-2609220442 (the skipped imported source's stray row forms its own card). */
async function card442() {
  const { cards } = await listPendingCsvTemplateWeeklyCards(ORG);
  return cards.find((c) => c.sources.some((s) => s.sourceFilename === "lot-2609220442.csv"))!;
}

// ---------------------------------------------------------------------------

test("Refresh alone never mutates pending data — it keeps rendering the pinned old version", async () => {
  const fake = liveLikeDb();
  useFake(fake);

  const { cards } = await listPendingCsvTemplateWeeklyCards(ORG);
  assert.deepEqual(fake.writes, []);

  // The stale card from the screenshot: v11, no date/week, lot-total PCS, no AFW.
  const stale = cards.find((c) => c.sources.some((s) => s.sourceFilename === "lot-2609220442.csv"))!;
  assert.deepEqual(stale.templateNames, ["Latest Mapping (v11)"]);
  assert.equal(stale.isoWeek, null);
  assert.equal(stale.combinedAverageFruitWeightG, null);
  assert.ok(stale.blockingIssues.some((i) => i.code === "packed_date_unresolved"));
  assert.ok(stale.blockingIssues.some((i) => i.code === "possible_lot_total_fruit_column"));
  assert.equal(pendingRow(fake, P_442).csv_mapping_template_id, V11);
});

test("bulk reprocessing upgrades old-template previews to the active version and recalculates date, week and AFW", async () => {
  const fake = liveLikeDb();
  useFake(fake);

  const result = await reprocessPendingCsvSources(ORG);
  assert.equal(result.dryRun, false);
  assert.deepEqual(
    { total: result.total, updated: result.updated, unchanged: result.unchanged, failed: result.failed, skippedImported: result.skippedImported },
    { total: 2, updated: 2, unchanged: 0, failed: 0, skippedImported: 1 }
  );
  assert.deepEqual(result.targetTemplates, [{ id: V13, name: "Latest Mapping", version: 13, sourceCount: 2 }]);
  const r442 = result.results.find((r) => r.pendingImportId === P_442)!;
  assert.deepEqual(r442.previousTemplate, { id: V11, name: "Latest Mapping", version: 11 });
  assert.deepEqual(r442.template, { id: V13, name: "Latest Mapping", version: 13 });

  assert.equal(pendingRow(fake, P_442).csv_mapping_template_id, V13);
  assert.equal(pendingRow(fake, P_443).csv_mapping_template_id, V13);

  const card = await card442();
  assert.deepEqual(
    card.sources.map((s) => s.sourceFilename).sort(),
    ["lot-2609220442.csv", "lot-2609220443.csv"],
    "both lots share variety 0699 / ISO 2026-W39"
  );
  assert.deepEqual(card.templateNames, ["Latest Mapping (v13)"]);
  // DDMMYYYY 22092026 -> 2026-09-22 -> ISO 2026-W39.
  assert.equal(card.isoYear, 2026);
  assert.equal(card.isoWeek, 39);
  assert.deepEqual(card.lots.map((l) => l.packedDate).sort(), ["2026-09-22", "2026-09-22"]);
  assert.ok(!card.blockingIssues.some((i) => i.code === "possible_lot_total_fruit_column"));
  assert.ok(!card.blockingIssues.some((i) => i.code === "packed_date_unresolved"));

  // Per source: lot-2609220442 is 420.948 kg / 2186 pcs = 192.6 g.
  const s442 = card.sources.find((s) => s.sourceFilename === "lot-2609220442.csv")!;
  assert.equal(round1(s442.averageFruitWeightG), 192.6);
  assert.equal(s442.averageFruitWeightBasis?.pieces, 2186);
  assert.equal(s442.templateVersion, 13);
  assert.equal(card.canImport, true);
});

test("a multi-source card is rebuilt with canonical combined AFW (total kg x 1000 / total pieces) and kg/m2", async () => {
  const fake = liveLikeDb();
  useFake(fake);
  await reprocessPendingCsvSources(ORG);

  const card = await card442();
  assert.equal(card.sourceFileCount, 2);
  const kg = card.sources.reduce((sum, s) => sum + (s.averageFruitWeightBasis?.kg ?? 0), 0);
  const pieces = card.sources.reduce((sum, s) => sum + (s.averageFruitWeightBasis?.pieces ?? 0), 0);
  assert.equal(pieces, 2186 + 700);
  assert.ok(Math.abs((card.combinedAverageFruitWeightG ?? 0) - (kg * 1000) / pieces) < 1e-9);
  assert.equal(round1(card.combinedAverageFruitWeightG), round1(((420.948 + 150) * 1000) / 2886));
  assert.equal(card.mappedKg, 570.95);
  assert.equal(card.kgPerM2, Math.round((570.95 / 14600) * 1000) / 1000);
});

test("the exact retained CSV is used and never modified", async () => {
  const fake = liveLikeDb();
  const before = JSON.stringify(fake.tables.csv_import_source_files);
  useFake(fake);
  await reprocessPendingCsvSources(ORG);
  assert.equal(JSON.stringify(fake.tables.csv_import_source_files), before);
  assert.ok(!fake.writes.some((w) => w.table === "csv_import_source_files"));
  // The recalculated figures can only have come from the retained bytes.
  const card = await card442();
  const s442 = card.sources.find((s) => s.sourceFilename === "lot-2609220442.csv")!;
  assert.equal(Math.round((s442.averageFruitWeightBasis?.kg ?? 0) * 1000) / 1000, 420.948);
});

test("reprocessing writes only pending-row template pointers — no yield entries, import runs or other tables", async () => {
  const fake = liveLikeDb();
  useFake(fake);
  await reprocessPendingCsvSources(ORG);

  assert.ok(fake.writes.length > 0);
  for (const w of fake.writes) {
    assert.equal(w.table, "agent_pending_imports");
    assert.equal(w.op, "update");
    assert.deepEqual(Object.keys(w.values as object).sort(), ["csv_mapping_template_id", "needs_template"]);
  }
  assert.equal(fake.tables.yield_entries.length, 0);
  assert.equal(fake.tables.yield_import_runs.length, 1);
  assert.equal(fake.tables.agent_pending_imports.length, 4, "no pending rows created or deleted");
});

test("completed/imported sources are never reprocessed", async () => {
  const fake = liveLikeDb();
  useFake(fake);
  const result = await reprocessPendingCsvSources(ORG);
  assert.ok(!result.results.some((r) => r.pendingImportId === P_IMPORTED));
  assert.equal(result.skippedImported, 1);
  assert.equal(pendingRow(fake, P_IMPORTED).csv_mapping_template_id, V11);
});

test("a second identical bulk request is idempotent", async () => {
  const fake = liveLikeDb();
  useFake(fake);
  await reprocessPendingCsvSources(ORG);
  const writesAfterFirst = fake.writes.length;
  const snapshot = JSON.stringify(fake.tables.agent_pending_imports);

  const second = await reprocessPendingCsvSources(ORG);
  assert.deepEqual({ updated: second.updated, unchanged: second.unchanged, failed: second.failed }, { updated: 0, unchanged: 2, failed: 0 });
  assert.equal(fake.writes.length, writesAfterFirst);
  assert.equal(JSON.stringify(fake.tables.agent_pending_imports), snapshot);
});

test("overlapping requests (double click / retry) are serialized and end in the same state", async () => {
  const fake = liveLikeDb();
  useFake(fake);
  const [a, b] = await Promise.all([reprocessPendingCsvSources(ORG), reprocessPendingCsvSources(ORG)]);
  assert.equal(a.updated + b.updated, 2);
  assert.equal(a.unchanged + b.unchanged, 2);
  assert.equal(fake.writes.length, 2);
  assert.equal(pendingRow(fake, P_442).csv_mapping_template_id, V13);
});

test("one invalid file fails on its own without rolling back the files that succeeded", async () => {
  const fake = liveLikeDb();
  fake.tables.agent_pending_imports.push(
    pending(P_MISSING, ORG, "lot-missing.csv", SRC_MISSING, V11, "2026-09-26T10:43:51Z"),
    { ...pending("dddddddd-0000-4000-8000-00000000f00d", ORG, "not-retained.csv", null, V11, "2026-09-26T10:43:52Z") }
  );
  useFake(fake);

  const errorLog = console.error;
  console.error = () => {};
  const result = await reprocessPendingCsvSources(ORG).finally(() => {
    console.error = errorLog;
  });
  assert.deepEqual({ updated: result.updated, failed: result.failed }, { updated: 2, failed: 2 });
  const missing = result.results.find((r) => r.pendingImportId === P_MISSING)!;
  assert.equal(missing.outcome, "failed");
  assert.equal(missing.sourceFilename, "lot-missing.csv");
  assert.equal(missing.error, "Referenced source file was not found.");
  const notRetained = result.results.find((r) => r.sourceFilename === "not-retained.csv")!;
  assert.match(notRetained.error ?? "", /not retained/);

  // The good files were still updated; the failed row is untouched.
  assert.equal(pendingRow(fake, P_442).csv_mapping_template_id, V13);
  assert.equal(pendingRow(fake, P_MISSING).csv_mapping_template_id, V11);
});

test("an unexpected error is reported to the user without raw database details", async () => {
  const fake = liveLikeDb();
  const from = fake.from;
  useFake(fake);
  (supabase as unknown as { from: unknown }).from = (table: string) => {
    const q = from(table);
    if (table === "csv_import_source_files") {
      return { ...q, select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'relation "x" violates constraint pk_secret', code: "XX000" } }) }) }) }) };
    }
    return q;
  };
  const errorSpy = console.error;
  console.error = () => {};
  try {
    const result = await reprocessPendingCsvSources(ORG);
    assert.equal(result.failed, 2);
    for (const r of result.results) {
      assert.equal(r.error, "This file could not be reprocessed. Try again, or open it in the Template Builder.");
      assert.doesNotMatch(r.error ?? "", /pk_secret|relation|XX000/);
    }
  } finally {
    console.error = errorSpy;
  }
});

test("per-card reprocessing uses the same function and touches only the requested pending rows", async () => {
  const fake = liveLikeDb();
  useFake(fake);
  const result = await reprocessPendingCsvSources(ORG, { pendingImportIds: [P_442] });
  assert.deepEqual(result.results.map((r) => r.pendingImportId), [P_442]);
  assert.equal(pendingRow(fake, P_442).csv_mapping_template_id, V13);
  assert.equal(pendingRow(fake, P_443).csv_mapping_template_id, V11);
});

test("cross-organization: another organization's pending rows are never listed, reprocessed or changed", async () => {
  const fake = liveLikeDb();
  useFake(fake);

  const asOrgA = await reprocessPendingCsvSources(ORG);
  assert.ok(!asOrgA.results.some((r) => r.pendingImportId === P_OTHER_ORG));

  // Org A naming org B's pending id explicitly gets nothing.
  const targeted = await reprocessPendingCsvSources(ORG, { pendingImportIds: [P_OTHER_ORG] });
  assert.equal(targeted.total, 0);
  // Org B naming org A's rows gets nothing either.
  const reverse = await reprocessPendingCsvSources(OTHER_ORG, { pendingImportIds: [P_442, P_443] });
  assert.equal(reverse.total, 0);

  assert.equal(pendingRow(fake, P_OTHER_ORG).csv_mapping_template_id, OTHER_ORG_TEMPLATE);
  assert.ok(!fake.writes.some((w) => w.table === "agent_pending_imports" && (w.values as { csv_mapping_template_id?: string }).csv_mapping_template_id === OTHER_ORG_TEMPLATE));
});

test("a dry run reports what would change and writes nothing", async () => {
  const fake = liveLikeDb();
  useFake(fake);
  const plan = await reprocessPendingCsvSources(ORG, { dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.updated, 2);
  assert.deepEqual(plan.targetTemplates.map((t) => `${t.name} v${t.version}`), ["Latest Mapping v13"]);
  assert.deepEqual(fake.writes, []);
  assert.equal(pendingRow(fake, P_442).csv_mapping_template_id, V11);
});

test("a source that no longer matches any active template goes back to awaiting a template", async () => {
  const fake = liveLikeDb();
  for (const t of fake.tables.csv_mapping_templates) if (t.id === V13) t.is_active = false;
  useFake(fake);
  const result = await reprocessPendingCsvSources(ORG);
  const r442 = result.results.find((r) => r.pendingImportId === P_442)!;
  assert.equal(r442.outcome, "updated");
  assert.equal(r442.needsTemplate, true);
  assert.equal(pendingRow(fake, P_442).needs_template, true);
  assert.equal(pendingRow(fake, P_442).csv_mapping_template_id, null);
});

test("request body validation: pendingImportIds must be UUIDs", () => {
  assert.deepEqual(parseReprocessBody({}), {});
  assert.deepEqual(parseReprocessBody(undefined), {});
  assert.deepEqual(parseReprocessBody({ pendingImportIds: [P_442, P_442] }), { pendingImportIds: [P_442] });
  assert.throws(() => parseReprocessBody({ pendingImportIds: ["source-files"] }), TemplateValidationError);
  assert.throws(() => parseReprocessBody({ pendingImportIds: "all" }), TemplateValidationError);
  assert.ok(REPROCESS_CONCURRENCY >= 1 && REPROCESS_CONCURRENCY <= 8);
});
