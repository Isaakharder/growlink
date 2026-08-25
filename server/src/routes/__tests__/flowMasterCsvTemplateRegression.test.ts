// Stage 9 regression proof: builds an actual FlowMaster CSV mapping
// template through the NEW generic CSV Import Template Builder (not
// hard-coded parser logic) and verifies it reproduces the exact totals the
// OLD, pinned FlowMaster pipeline already verifies for the same real
// files — proving the new system is a faithful, reusable replacement
// rather than a reimplementation with different behavior.
//
// Fixtures: server/src/utils/__tests__/fixtures/flowmaster-csv/*.csv — the
// ACTUAL FlowMaster CSV exports for lots 2608170362 / 2608180363 /
// 2608190364 (Aug 17-19 2026, variety Cadalora), copied byte-for-byte from
// the files the user provided. These are the same three files whose
// numbers are already baked into server/src/utils/__tests__/flowMasterCsvParser.test.ts
// (per-lot SM-XXL breakdowns) and server/src/routes/__tests__/pdfImport.test.ts
// (the combined 31,487.94 kg weekly total via mapSizeNamesToIds +
// calculateTotals). This file reproduces both through the new engine.
//
// NOT covered here, and not fabricated: lot 2608210373 and an Aug 20-21
// week. No file matching either was found in the repo or supplied: see the
// final report for this task. Do not add a test asserting numbers for
// data that was never actually parsed.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../../config/supabase";
import { parseCsvGrid } from "../../utils/csvGridParser";
import { normalizeCsvWithTemplate } from "../../utils/csvTemplateEngine";
import type { ConditionalRowRule, TemplateConfig, ValueMapping } from "../../utils/csvTemplateTypes";
import {
  createTemplate,
  importCsvTemplateGroup,
  buildCsvPreview,
  parseTemplateWriteBody,
  type TemplateRow
} from "../csvMappingTemplates";

const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";
const TEST_USER_ID = "00000000-0000-0000-0000-0000000000bb";

const FIXTURES_DIR = join(__dirname, "..", "..", "utils", "__tests__", "fixtures", "flowmaster-csv");
const LOT_AUG17 = readFileSync(join(FIXTURES_DIR, "lot-2608170362.csv"), "utf-8");
const LOT_AUG18 = readFileSync(join(FIXTURES_DIR, "lot-2608180363.csv"), "utf-8");
const LOT_AUG19 = readFileSync(join(FIXTURES_DIR, "lot-2608190364.csv"), "utf-8");

// The generic template as it would be saved via the builder for a real
// FlowMaster export: exact positional mapping (never by header name alone
// — both WEIGHT/AVG/PCS pairs share a name, only position tells them
// apart), matching the spec's required FlowMaster mapping precisely.
const FLOWMASTER_VALUE_MAPPINGS: ValueMapping[] = [
  { sourceField: "size_label", rawValue: "SM", action: "create", newSizeName: `RegressionSmall-${randomUUID()}` },
  { sourceField: "size_label", rawValue: "MD", action: "create", newSizeName: `RegressionMedium-${randomUUID()}` },
  { sourceField: "size_label", rawValue: "LG", action: "create", newSizeName: `RegressionLarge-${randomUUID()}` },
  { sourceField: "size_label", rawValue: "SXL", action: "create", newSizeName: `RegressionSXL-${randomUUID()}` },
  { sourceField: "size_label", rawValue: "XL", action: "create", newSizeName: `RegressionXL-${randomUUID()}` },
  { sourceField: "size_label", rawValue: "XXL", action: "create", newSizeName: `RegressionXXL-${randomUUID()}` }
];

// One valid, complete way to configure a FlowMaster template: explicitly
// resolve every MARKET/SIZE1 value that appears in these 3 real files, so
// the whole file imports cleanly end-to-end (used by the full-import test
// below, which reproduces the pdfImport.test.ts regression figure of
// Class 1 SM-XXL only).
//
// This is NOT a claim about what Denva's live flowmaster_size_rules table
// actually contains today — it doesn't (verified live: only one row,
// {NOMARKET}->create, plus ignoredSizeLabels=["{OVERSIZED}","ALL SIZES"]).
// See "genuinely unresolved" test below, which uses that real live
// configuration and shows Green/Doubles/24ct/underweight are pending
// today, not auto-ignored — don't assume otherwise when building a
// template from real saved org settings.
const FLOWMASTER_RULES: ConditionalRowRule[] = [
  { id: "r-24ct", priority: 1, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "24ct" }], action: "ignore" },
  { id: "r-green", priority: 2, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "Green" }], action: "ignore" },
  { id: "r-doubles", priority: 3, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "Doubles" }], action: "ignore" },
  { id: "r-waste", priority: 4, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "waste" }], action: "ignore" },
  { id: "r-underweight", priority: 5, conditionLogic: "AND", conditions: [{ field: "size_label", operator: "equals", value: "underweight" }], action: "ignore" }
];

function flowMasterTemplateConfig(): TemplateConfig {
  return {
    delimiter: ",",
    encoding: "utf-8",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    dataEndRowIndex: null,
    skipRowIndexes: [],
    blankRowBehavior: "skip",
    columnMappings: [
      { columnIndex: 0, field: "lot_number" },
      { columnIndex: 1, field: "run_number" },
      { columnIndex: 2, field: "variety" },
      { columnIndex: 3, field: "packed_date", dateFormat: "DDMMYYYY" },
      { columnIndex: 5, field: "market_grade" },
      { columnIndex: 6, field: "size_label" },
      { columnIndex: 8, field: "size_weight_kg" },
      { columnIndex: 9, field: "average_fruit_weight_g" },
      { columnIndex: 10, field: "piece_count" }
      // Columns 11/12/13 — the SECOND WEIGHT/AVG/PCS (lot-level totals) —
      // are deliberately left unmapped. This is the exact bug the
      // position-based mapping exists to prevent: the second WEIGHT must
      // never be assigned to every size row.
    ],
    fixedCellMappings: [],
    valueMappings: FLOWMASTER_VALUE_MAPPINGS,
    rules: FLOWMASTER_RULES
  };
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

test("FlowMaster template built via the generic engine: lot 2608170362 (Aug 17) reproduces the pinned SM-XXL breakdown", () => {
  const grid = parseCsvGrid(LOT_AUG17, ",");
  const preview = normalizeCsvWithTemplate(grid.rows, flowMasterTemplateConfig(), {
    sizeNameById: new Map(),
    alreadyImportedLotNumbers: new Set()
  });

  assert.equal(preview.groups.length, 1);
  const group = preview.groups[0];

  assert.equal(group.lotNumber, "2608170362");
  assert.equal(group.varietyRaw, "Cadalora");
  // BEGINDT (17082026, DDMMYYYY) is the authoritative packed date.
  assert.equal(group.packedDate, "2026-08-17");

  const sizeNames = Object.keys(group.sizeKg);
  const findKg = (suffix: string) => group.sizeKg[sizeNames.find((n) => n.startsWith(suffix)) ?? ""] ?? 0;

  assert.equal(roundToCents(findKg("RegressionSmall")), 34.12);
  assert.equal(roundToCents(findKg("RegressionMedium")), 468.12);
  assert.equal(roundToCents(findKg("RegressionLarge")), 1380.91);
  assert.equal(roundToCents(findKg("RegressionSXL")), 3257.1);
  assert.equal(roundToCents(findKg("RegressionXL")), 4489.31);
  assert.equal(roundToCents(findKg("RegressionXXL")), 353.21);

  assert.equal(roundToCents(group.reconciliation.recognizedSizeKg), 9982.77);

  // Never zero despite recognized rows existing.
  assert.ok(group.reconciliation.recognizedSizeKg > 0);

  // The second (lot-total) WEIGHT column (11118.075, repeated on every row)
  // must never appear as a row's own size weight.
  for (const row of group.rows) {
    assert.notEqual(row.sizeWeightKg, 11118.075);
  }
});

test("FlowMaster template, built with Denva's genuinely live rules (no rules for Green/Doubles/24ct/underweight), leaves them unresolved rather than silently ignored", () => {
  // Real, currently-live Denva settings verified against the DB during
  // planning: flowmaster_size_rules has exactly one row ({NOMARKET}
  // ->create, irrelevant here since MARKET is never blank in this file),
  // and ignoredSizeLabels is ["{OVERSIZED}", "ALL SIZES"] — nothing else.
  const liveConfig: TemplateConfig = {
    ...flowMasterTemplateConfig(),
    valueMappings: FLOWMASTER_VALUE_MAPPINGS,
    rules: [
      { id: "r-oversized", priority: 1, conditionLogic: "AND", conditions: [{ field: "size_label", operator: "equals", value: "{oversized}" }], action: "ignore" }
      // No rule for 24ct / Green / Doubles / underweight — matches the
      // real live DB exactly. Do not add ignore rules for them here.
    ]
  };

  const grid = parseCsvGrid(LOT_AUG17, ",");
  const preview = normalizeCsvWithTemplate(grid.rows, liveConfig, { sizeNameById: new Map(), alreadyImportedLotNumbers: new Set() });
  const group = preview.groups[0];

  const byMarket = (market: string) => group.rows.find((r) => r.marketGradeRaw === market);

  // waste/{oversized} is ignored (matches ignoredSizeLabels).
  assert.equal(byMarket("waste")?.action, "ignored");

  // 24ct, Green, Doubles, and Class 1/underweight all have no saved rule
  // today — they must surface as unresolved, not be guessed at.
  assert.equal(byMarket("24ct")?.action, "unresolved");
  assert.equal(byMarket("Green")?.action, "unresolved");
  assert.equal(byMarket("Doubles")?.action, "unresolved");
  const underweightRow = group.rows.find((r) => r.sizeLabelRaw === "underweight");
  assert.equal(underweightRow?.action, "unresolved");

  // The Class 1 SM-XXL total is still correct and unaffected.
  assert.equal(roundToCents(group.reconciliation.directMappedKg), 9982.77);

  // Unresolved, non-zero-kg rows block import until configured.
  assert.equal(preview.canImport, false);
  assert.ok(preview.validationIssues.some((i) => i.code === "unresolved_size_label"));
});

test("FlowMaster template built via the generic engine: each of the 3 real lots keeps its own distinct packed date", () => {
  const configs = [LOT_AUG17, LOT_AUG18, LOT_AUG19].map((text) => parseCsvGrid(text, ","));
  const dates = configs.map(
    (grid) =>
      normalizeCsvWithTemplate(grid.rows, flowMasterTemplateConfig(), { sizeNameById: new Map(), alreadyImportedLotNumbers: new Set() })
        .groups[0].packedDate
  );
  assert.deepEqual(dates, ["2026-08-17", "2026-08-18", "2026-08-19"]);
});

test("FlowMaster template built via the generic engine: AFW is kg-weighted from included rows only, not from the lot-level AVG column", () => {
  const grid = parseCsvGrid(LOT_AUG17, ",");
  const preview = normalizeCsvWithTemplate(grid.rows, flowMasterTemplateConfig(), {
    sizeNameById: new Map(),
    alreadyImportedLotNumbers: new Set()
  });
  const group = preview.groups[0];

  // Hand-computed kg-weighted AVG (col 9) over the 6 included Class 1 rows.
  const included = [
    { kg: 34.123, avg: 91.2 },
    { kg: 468.121, avg: 120.1 },
    { kg: 1380.906, avg: 143.7 },
    { kg: 3257.101, avg: 166.3 },
    { kg: 4489.312, avg: 194.1 },
    { kg: 353.205, avg: 230.4 }
  ];
  const numerator = included.reduce((sum, r) => sum + r.kg * r.avg, 0);
  const denominator = included.reduce((sum, r) => sum + r.kg, 0);
  const expectedAfw = numerator / denominator;

  assert.ok(Math.abs((group.averageFruitWeightG ?? 0) - expectedAfw) < 1e-6);
  // 171.3 is the lot-level AVG (second AVG column) — must never be used directly.
  assert.notEqual(roundToCents(group.averageFruitWeightG ?? 0), 171.3);
});

test(
  "FlowMaster template, saved and imported through the real API for all 3 real lots, " +
    "produces the exact pinned 31,487.94 kg combined weekly total",
  async () => {
    const varietyName = `Cadalora-regression-${randomUUID()}`;
    const { data: variety, error: varietyErr } = await supabase
      .from("varieties")
      .insert({ organization_id: DENVA_ORG_ID, name: varietyName, area_m2: 1000, case_kg: 11, status: "active", color: "green" })
      .select("id")
      .single();
    assert.equal(varietyErr, null, varietyErr?.message);
    const varietyId = variety!.id as string;

    // Rewrite the variety name into each fixture's raw text so it matches
    // the throwaway test variety instead of colliding with any real
    // "Cadalora" the organization may actually have.
    const files = [LOT_AUG17, LOT_AUG18, LOT_AUG19].map((text) => text.replace(/Cadalora/g, varietyName));

    let template: TemplateRow | null = null;
    const sourceFileIds: string[] = [];
    let entryId: string | null = null;

    try {
      const firstGrid = parseCsvGrid(files[0], ",");
      const { data: firstSourceFile, error: firstSourceErr } = await supabase
        .from("csv_import_source_files")
        .insert({
          organization_id: DENVA_ORG_ID,
          file_hash: `regression-${randomUUID()}`,
          filename: "lot-2608170362.csv",
          raw_text: files[0],
          row_count: firstGrid.rowCount,
          column_count: firstGrid.columnCount,
          delimiter: ",",
          uploaded_by: TEST_USER_ID
        })
        .select("id")
        .single();
      assert.equal(firstSourceErr, null, firstSourceErr?.message);
      sourceFileIds.push(firstSourceFile!.id as string);

      const writeBody = parseTemplateWriteBody({
        name: `FlowMaster CSV Export (regression) ${randomUUID()}`,
        sourceFileId: sourceFileIds[0],
        ...flowMasterTemplateConfig()
      });
      template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, writeBody);

      let lastMode: "create" | "append" | null = null;

      for (let i = 0; i < files.length; i += 1) {
        let sourceFileId = sourceFileIds[i];
        if (sourceFileId === undefined) {
          const grid = parseCsvGrid(files[i], ",");
          const { data: sourceFile, error: sourceErr } = await supabase
            .from("csv_import_source_files")
            .insert({
              organization_id: DENVA_ORG_ID,
              file_hash: `regression-${randomUUID()}`,
              filename: `lot-${i}.csv`,
              raw_text: files[i],
              row_count: grid.rowCount,
              column_count: grid.columnCount,
              delimiter: ",",
              uploaded_by: TEST_USER_ID
            })
            .select("id")
            .single();
          assert.equal(sourceErr, null, sourceErr?.message);
          sourceFileId = sourceFile!.id as string;
          sourceFileIds.push(sourceFileId);
        }

        const previewResult = await buildCsvPreview(DENVA_ORG_ID, { sourceFileId, templateId: template.id });
        assert.equal(previewResult.preview.canImport, true, JSON.stringify(previewResult.preview.validationIssues));
        const group = previewResult.preview.groups[0];

        const importResult = await importCsvTemplateGroup(DENVA_ORG_ID, TEST_USER_ID, {
          sourceFileId,
          templateId: template.id,
          groupKey: group.groupKey,
          approvedGroup: group
        });

        lastMode = importResult.mode;
        entryId = importResult.entryId;
      }

      // First lot creates the weekly entry, the next two append to it.
      assert.equal(lastMode, "append");

      const { data: finalEntry, error: finalErr } = await supabase
        .from("yield_entries")
        .select("total_kg")
        .eq("id", entryId as string)
        .single();
      assert.equal(finalErr, null, finalErr?.message);

      // The exact figure verified by the existing, pinned
      // pdfImport.test.ts regression test for these same 3 real files.
      assert.equal(roundToCents(Number(finalEntry!.total_kg)), 31487.94);
    } finally {
      if (entryId) {
        await supabase.from("yield_entry_daily_breakdown").delete().eq("yield_entry_id", entryId);
        await supabase.from("yield_entries").delete().eq("id", entryId);
      }
      await supabase.from("yield_import_runs").delete().eq("organization_id", DENVA_ORG_ID).eq("variety_id", varietyId);
      if (template) await supabase.from("csv_mapping_templates").delete().eq("template_group_id", template.template_group_id);
      for (const id of sourceFileIds) {
        await supabase.from("csv_import_source_files").delete().eq("id", id);
      }
      await supabase.from("yield_sizes").delete().ilike("name", "Regression%");
      await supabase.from("varieties").delete().eq("id", varietyId);
    }
  }
);

// No fixture exists for lot 2608210373 or an Aug 20-21 week — none was
// found in the repo or supplied, so no test asserts numbers for it here.
// See the final report: the "31,487.94 kg" figure the task named turned
// out to already be the SAME Aug 17-19 combined total verified above
// (confirmed against pdfImport.test.ts), not a separate, still-missing one.
