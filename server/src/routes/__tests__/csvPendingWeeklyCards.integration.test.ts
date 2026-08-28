// Integration tests for the "weekly variety card" pending-review workflow:
// grouping by (organization, resolved variety, iso year, iso week), label
// resolution (pending-only overrides vs. a new template version), and the
// server-owned grouped import. Run directly against the live Supabase DB
// (project convention — no local Docker Supabase); every test creates its
// own throwaway org-scoped rows and cleans them up. Never touches First
// Light's real data/templates.
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../../config/supabase";
import {
  parseAndMatchCsvFile,
  createTemplate,
  getTemplateById,
  parseTemplateWriteBody,
  createPendingCsvTemplateImport,
  listPendingCsvTemplateWeeklyCards,
  resolvePendingLabelsForSources,
  resolveLabelsForTemplate,
  importWeeklyCard,
  TemplateNotFoundError,
  TemplateValidationError,
  type TemplateWriteInput
} from "../csvMappingTemplates";

const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";
const FIRST_LIGHT_ORG_ID = "e1b8a6cf-032c-48f0-852a-982dd58b9f9c";
const TEST_USER_ID = "00000000-0000-0000-0000-0000000000ee";

async function cleanupAll(...tasks: Array<() => PromiseLike<unknown>>): Promise<void> {
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      console.warn("[test cleanup] a cleanup step failed (continuing with the rest):", err instanceof Error ? err.message : err);
    }
  }
}

async function cleanupTemplateGroup(templateGroupId: string) {
  await supabase.from("csv_mapping_templates").delete().eq("template_group_id", templateGroupId);
}

async function cleanupSourceFilesByPrefix(organizationId: string, prefix: string) {
  const { data: sourceFiles } = await supabase
    .from("csv_import_source_files")
    .select("id")
    .eq("organization_id", organizationId)
    .ilike("filename", `${prefix}%`);
  for (const sf of sourceFiles ?? []) {
    await supabase.from("yield_import_runs").delete().eq("organization_id", organizationId).eq("source_file_id", sf.id as string);
    await supabase.from("agent_pending_imports").delete().eq("organization_id", organizationId).eq("source_file_id", sf.id as string);
    await supabase.from("csv_source_value_overrides").delete().eq("organization_id", organizationId).eq("source_file_id", sf.id as string);
    await supabase.from("csv_import_source_files").delete().eq("id", sf.id as string);
  }
}

async function createTestVariety(organizationId: string, name: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabase
    .from("varieties")
    .insert({ organization_id: organizationId, name, area_m2: 100, case_kg: 10, status: "active", color: "green" })
    .select("id, name")
    .single();
  if (error) throw error;
  return { id: data.id as string, name: data.name as string };
}

async function cleanupVarietyAndEntries(organizationId: string, varietyId: string) {
  const { data: entries } = await supabase.from("yield_entries").select("id").eq("organization_id", organizationId).eq("variety_id", varietyId);
  for (const entry of entries ?? []) {
    await supabase.from("yield_entry_daily_breakdown").delete().eq("yield_entry_id", entry.id as string);
  }
  await supabase.from("yield_entries").delete().eq("organization_id", organizationId).eq("variety_id", varietyId);
  await supabase.from("yield_import_runs").delete().eq("organization_id", organizationId).eq("variety_id", varietyId);
  await supabase.from("varieties").delete().eq("id", varietyId);
}

// A real yield_sizes row, created directly rather than through a template's
// "create" value mapping — that action deliberately stays name-only until
// resolved at actual import time (see ensureYieldSizeId), so tests that
// need a real, immediately-usable targetSizeId (map/distribute resolutions)
// set one up up front instead.
async function createTestYieldSize(organizationId: string, name: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabase
    .from("yield_sizes")
    .insert({ organization_id: organizationId, name, sort_order: 0, status: "active" })
    .select("id, name")
    .single();
  if (error) throw error;
  return { id: data.id as string, name: data.name as string };
}

async function cleanupYieldSize(id: string) {
  await supabase.from("yield_sizes").delete().eq("id", id);
}

// Columns: Lot,Market,Size,Kg,Variety,Date (DDMMYYYY) — a simplified
// stand-in for the real Aweta/FlowMaster layout, tagged per-test so
// fingerprints never collide across tests/runs.
function csvRow(lot: string, market: string, size: string, kg: number, variety: string, dateDDMMYYYY: string): string {
  return `${lot},${market},${size},${kg},${variety},${dateDDMMYYYY}`;
}

function templateBody(sourceFileId: string, name: string, smallSizeId: string): TemplateWriteInput {
  return parseTemplateWriteBody({
    name,
    sourceFileId,
    delimiter: ",",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    dataEndRowIndex: null,
    skipRowIndexes: [],
    blankRowBehavior: "skip",
    columnMappings: [
      { columnIndex: 0, field: "lot_number" },
      { columnIndex: 1, field: "market_grade" },
      { columnIndex: 2, field: "size_label" },
      { columnIndex: 3, field: "size_weight_kg" },
      { columnIndex: 4, field: "variety" },
      { columnIndex: 5, field: "packed_date", dateFormat: "DDMMYYYY" }
    ],
    fixedCellMappings: [],
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "map", targetSizeId: smallSizeId }],
    rules: []
  });
}

async function uploadAndStage(
  organizationId: string,
  filename: string,
  csvText: string,
  templateId: string
): Promise<{ sourceFileId: string; pendingId: string }> {
  const uploaded = await parseAndMatchCsvFile(organizationId, TEST_USER_ID, { buffer: Buffer.from(csvText, "utf-8"), originalname: filename });
  const pending = await createPendingCsvTemplateImport(organizationId, uploaded.sourceFileId, filename, templateId, false);
  return { sourceFileId: uploaded.sourceFileId, pendingId: pending.id };
}

test("weekly cards: two source files for the same variety/week (different lots/dates) form one card; a source removal recalculates it", async () => {
  const marker = randomUUID();
  const prefix = `wc-basic-${marker}`;
  const variety = await createTestVariety(DENVA_ORG_ID, `WcBasicVariety-${marker}`);
  const smallSize = await createTestYieldSize(DENVA_ORG_ID, `WcBasicSmall-${marker}`);

  const csvA = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lotA", "Class 1", "SM", 10, variety.name, "25082026")}\n`;
  const uploadedA = await parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer: Buffer.from(csvA), originalname: `${prefix}-a.csv` });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, templateBody(uploadedA.sourceFileId, `WcBasicTemplate-${marker}`, smallSize.id));
  await createPendingCsvTemplateImport(DENVA_ORG_ID, uploadedA.sourceFileId, `${prefix}-a.csv`, template.id, false);

  const csvB = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lotB", "Class 1", "SM", 20, variety.name, "26082026")}\n`;
  const { pendingId: pendingIdB } = await uploadAndStage(DENVA_ORG_ID, `${prefix}-b.csv`, csvB, template.id);

  try {
    const { cards } = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const card = cards.find((c) => c.varietyId === variety.id);
    assert.ok(card, "expected a weekly card for this variety/week");
    assert.equal(card!.lotCount, 2);
    assert.equal(card!.sourceFileCount, 2);
    assert.equal(card!.mappedKg, 30);
    assert.deepEqual(card!.lots.map((l) => l.lotNumber).sort(), ["lotA", "lotB"]);

    // Remove one source (the same hard-delete the "Remove" UI action uses).
    await supabase.from("agent_pending_imports").delete().eq("id", pendingIdB).eq("organization_id", DENVA_ORG_ID);

    const { cards: cardsAfter } = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const cardAfter = cardsAfter.find((c) => c.varietyId === variety.id);
    assert.ok(cardAfter, "the card must still exist for the remaining source");
    assert.equal(cardAfter!.lotCount, 1);
    assert.equal(cardAfter!.sourceFileCount, 1);
    assert.equal(cardAfter!.mappedKg, 10);
    assert.deepEqual(cardAfter!.lots.map((l) => l.lotNumber), ["lotA"]);
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByPrefix(DENVA_ORG_ID, prefix),
      () => cleanupVarietyAndEntries(DENVA_ORG_ID, variety.id),
      () => cleanupYieldSize(smallSize.id)
    );
  }
});

test("resolve labels (pending-data-only): a map resolution clears the unresolved label for the affected source without versioning the template", async () => {
  const marker = randomUUID();
  const prefix = `wc-resolve-map-${marker}`;
  const variety = await createTestVariety(DENVA_ORG_ID, `WcResolveMapVariety-${marker}`);
  const smallSize = await createTestYieldSize(DENVA_ORG_ID, `WcResolveMapSmall-${marker}`);

  const csv = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lot1", "Class 1", "SM", 10, variety.name, "25082026")}\n${csvRow("lot1", "Class 1", "Green", 5, variety.name, "25082026")}\n`;
  const uploaded = await parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, templateBody(uploaded.sourceFileId, `WcResolveMapTemplate-${marker}`, smallSize.id));
  await createPendingCsvTemplateImport(DENVA_ORG_ID, uploaded.sourceFileId, `${prefix}.csv`, template.id, false);

  try {
    const before = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const cardBefore = before.cards.find((c) => c.varietyId === variety.id)!;
    assert.equal(cardBefore.unresolvedLabelGroups.length, 1);
    assert.equal(cardBefore.unresolvedLabelGroups[0].rawValue, "Green");
    assert.equal(cardBefore.canImport, false);

    await resolvePendingLabelsForSources(DENVA_ORG_ID, TEST_USER_ID, [uploaded.sourceFileId], [
      { sourceField: "size_label", rawValue: "Green", action: "map", targetSizeId: smallSize.id }
    ]);

    const after = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const cardAfter = after.cards.find((c) => c.varietyId === variety.id)!;
    assert.equal(cardAfter.unresolvedLabelGroups.length, 0);
    assert.equal(cardAfter.canImport, true);
    assert.equal(cardAfter.mappedKg, 15);

    // The template itself must be untouched (still version 1).
    const templateAfter = await getTemplateById(DENVA_ORG_ID, template.id);
    assert.equal(templateAfter!.version, 1);
    assert.equal(templateAfter!.value_mappings.length, 1);
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByPrefix(DENVA_ORG_ID, prefix),
      () => cleanupVarietyAndEntries(DENVA_ORG_ID, variety.id),
      () => cleanupYieldSize(smallSize.id)
    );
  }
});

test("resolve labels (pending-data-only): an ignore resolution removes kg and pieces from mapped totals but keeps ignoredKg visible", async () => {
  const marker = randomUUID();
  const prefix = `wc-resolve-ignore-${marker}`;
  const variety = await createTestVariety(DENVA_ORG_ID, `WcResolveIgnoreVariety-${marker}`);
  const smallSize = await createTestYieldSize(DENVA_ORG_ID, `WcResolveIgnoreSmall-${marker}`);

  const csv = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lot1", "Class 1", "SM", 10, variety.name, "25082026")}\n${csvRow("lot1", "Class 1", "undersized", 2.5, variety.name, "25082026")}\n`;
  const uploaded = await parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, templateBody(uploaded.sourceFileId, `WcResolveIgnoreTemplate-${marker}`, smallSize.id));
  await createPendingCsvTemplateImport(DENVA_ORG_ID, uploaded.sourceFileId, `${prefix}.csv`, template.id, false);

  try {
    await resolvePendingLabelsForSources(DENVA_ORG_ID, TEST_USER_ID, [uploaded.sourceFileId], [
      { sourceField: "size_label", rawValue: "undersized", action: "ignore" }
    ]);

    const { cards } = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const card = cards.find((c) => c.varietyId === variety.id)!;
    assert.equal(card.canImport, true);
    assert.equal(card.mappedKg, 10);
    assert.equal(card.ignoredKg, 2.5);
    assert.equal(card.unresolvedLabelGroups.length, 0);
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByPrefix(DENVA_ORG_ID, prefix),
      () => cleanupVarietyAndEntries(DENVA_ORG_ID, variety.id),
      () => cleanupYieldSize(smallSize.id)
    );
  }
});

test("resolve labels (pending-data-only): a distribute resolution preserves the exact total across the selected destination sizes", async () => {
  const marker = randomUUID();
  const prefix = `wc-resolve-dist-${marker}`;
  const variety = await createTestVariety(DENVA_ORG_ID, `WcResolveDistVariety-${marker}`);
  const smallSize = await createTestYieldSize(DENVA_ORG_ID, `WcResolveDistSmall-${marker}`);

  const csv = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lot1", "Class 1", "SM", 30, variety.name, "25082026")}\n${csvRow("lot1", "Class 1", "Doubles", 10, variety.name, "25082026")}\n`;
  const uploaded = await parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, templateBody(uploaded.sourceFileId, `WcResolveDistTemplate-${marker}`, smallSize.id));
  await createPendingCsvTemplateImport(DENVA_ORG_ID, uploaded.sourceFileId, `${prefix}.csv`, template.id, false);

  try {
    await resolvePendingLabelsForSources(DENVA_ORG_ID, TEST_USER_ID, [uploaded.sourceFileId], [
      { sourceField: "size_label", rawValue: "Doubles", action: "distribute", distributeSizeIds: [smallSize.id] }
    ]);

    const { cards } = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const card = cards.find((c) => c.varietyId === variety.id)!;
    // All 10kg distributed to the only destination (SM), on top of its own 30kg.
    assert.equal(card.mappedKg, 40);
    assert.equal(card.distributedKg, 10);
    assert.equal(Object.values(card.sizeKg).reduce((s, v) => s + v, 0), 40);
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByPrefix(DENVA_ORG_ID, prefix),
      () => cleanupVarietyAndEntries(DENVA_ORG_ID, variety.id),
      () => cleanupYieldSize(smallSize.id)
    );
  }
});

test("resolve labels (save for future imports): one new template version contains every submitted resolution; the old version is untouched; affected pending sources reprocess automatically", async () => {
  const marker = randomUUID();
  const prefix = `wc-resolve-tpl-${marker}`;
  const variety = await createTestVariety(DENVA_ORG_ID, `WcResolveTplVariety-${marker}`);
  const smallSize = await createTestYieldSize(DENVA_ORG_ID, `WcResolveTplSmall-${marker}`);

  const csv = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lot1", "Class 1", "SM", 10, variety.name, "25082026")}\n${csvRow("lot1", "Class 1", "Green", 5, variety.name, "25082026")}\n${csvRow("lot1", "Class 1", "Doubles", 3, variety.name, "25082026")}\n`;
  const uploaded = await parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, templateBody(uploaded.sourceFileId, `WcResolveTplTemplate-${marker}`, smallSize.id));
  await createPendingCsvTemplateImport(DENVA_ORG_ID, uploaded.sourceFileId, `${prefix}.csv`, template.id, false);

  try {
    const templateBefore = await getTemplateById(DENVA_ORG_ID, template.id);

    const result = await resolveLabelsForTemplate(DENVA_ORG_ID, TEST_USER_ID, template.id, [
      { sourceField: "size_label", rawValue: "Green", action: "map", targetSizeId: smallSize.id },
      { sourceField: "size_label", rawValue: "Doubles", action: "ignore" }
    ]);

    assert.equal(result.newTemplateVersion, 2);
    assert.equal(result.reprocessedSourceCount, 1);

    // v1 (Aweta-equivalent) must be completely unchanged.
    const v1 = await getTemplateById(DENVA_ORG_ID, template.id);
    assert.equal(v1!.version, 1);
    assert.equal(v1!.is_current, false);
    assert.equal(v1!.value_mappings.length, 1);

    // v2 must contain the original mapping PLUS both new resolutions — one version, not two.
    const v2 = await getTemplateById(DENVA_ORG_ID, result.newTemplateId);
    assert.equal(v2!.is_current, true);
    assert.equal(v2!.is_active, true);
    assert.equal(v2!.value_mappings.length, 3);

    // The pending row reprocessed automatically (repointed to v2, no re-upload).
    const { data: pendingRow } = await supabase
      .from("agent_pending_imports")
      .select("csv_mapping_template_id")
      .eq("organization_id", DENVA_ORG_ID)
      .eq("source_file_id", uploaded.sourceFileId)
      .single();
    assert.equal(pendingRow?.csv_mapping_template_id, result.newTemplateId);

    const { cards } = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const card = cards.find((c) => c.varietyId === variety.id)!;
    assert.equal(card.canImport, true);
    assert.equal(card.mappedKg, 15); // 10 (SM) + 5 (Green -> mapped to same size)
    assert.equal(card.ignoredKg, 3); // Doubles ignored
    assert.equal(card.templateNames[0], `${templateBefore!.name} (v2)`);
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByPrefix(DENVA_ORG_ID, prefix),
      () => cleanupVarietyAndEntries(DENVA_ORG_ID, variety.id),
      () => cleanupYieldSize(smallSize.id)
    );
  }
});

test("grouped import: blocked while a blocking label/issue remains; once resolved, writes exactly the server preview; a retry cannot double-count", async () => {
  const marker = randomUUID();
  const prefix = `wc-import-${marker}`;
  const variety = await createTestVariety(DENVA_ORG_ID, `WcImportVariety-${marker}`);
  const smallSize = await createTestYieldSize(DENVA_ORG_ID, `WcImportSmall-${marker}`);

  const csvA = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lotA", "Class 1", "SM", 10, variety.name, "25082026")}\n${csvRow("lotA", "Class 1", "Green", 5, variety.name, "25082026")}\n`;
  const uploadedA = await parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer: Buffer.from(csvA), originalname: `${prefix}-a.csv` });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, templateBody(uploadedA.sourceFileId, `WcImportTemplate-${marker}`, smallSize.id));
  await createPendingCsvTemplateImport(DENVA_ORG_ID, uploadedA.sourceFileId, `${prefix}-a.csv`, template.id, false);

  const csvB = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lotB", "Class 1", "SM", 20, variety.name, "26082026")}\n`;
  await uploadAndStage(DENVA_ORG_ID, `${prefix}-b.csv`, csvB, template.id);

  try {
    const beforeCards = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const cardBefore = beforeCards.cards.find((c) => c.varietyId === variety.id)!;
    assert.equal(cardBefore.canImport, false);
    await assert.rejects(() => importWeeklyCard(DENVA_ORG_ID, TEST_USER_ID, cardBefore.cardKey), TemplateValidationError);

    // Resolve the blocking label for this pending data only.
    await resolvePendingLabelsForSources(DENVA_ORG_ID, TEST_USER_ID, [uploadedA.sourceFileId], [
      { sourceField: "size_label", rawValue: "Green", action: "map", targetSizeId: smallSize.id }
    ]);

    const midCards = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const cardMid = midCards.cards.find((c) => c.varietyId === variety.id)!;
    assert.equal(cardMid.canImport, true);
    assert.equal(cardMid.mappedKg, 35); // 10 + 5 + 20
    const expectedSizeKg = { ...cardMid.sizeKg };

    const importResult = await importWeeklyCard(DENVA_ORG_ID, TEST_USER_ID, cardMid.cardKey);
    assert.equal(importResult.results.filter((r) => r.status === "imported").length, 2);
    assert.equal(importResult.totalKgImported, 35);

    const { data: entry } = await supabase
      .from("yield_entries")
      .select("size_kg")
      .eq("organization_id", DENVA_ORG_ID)
      .eq("variety_id", variety.id)
      .eq("year", cardMid.isoYear)
      .eq("week", cardMid.isoWeek)
      .single();
    const sizeKgById = entry!.size_kg as Record<string, number>;
    // The saved result must equal the previewed size totals exactly.
    const savedTotal = Object.values(sizeKgById).reduce((s, v) => s + v, 0);
    const previewedTotal = Object.values(expectedSizeKg).reduce((s, v) => s + v, 0);
    assert.equal(savedTotal, previewedTotal);
    assert.equal(savedTotal, 35);

    // The card is gone (both sources' pending rows were consumed by the import).
    const afterCards = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    assert.ok(!afterCards.cards.some((c) => c.varietyId === variety.id));

    // A retry (same cardKey) must fail cleanly rather than double-import.
    await assert.rejects(() => importWeeklyCard(DENVA_ORG_ID, TEST_USER_ID, cardMid.cardKey), TemplateNotFoundError);
    const { data: entryAfterRetry } = await supabase
      .from("yield_entries")
      .select("size_kg")
      .eq("organization_id", DENVA_ORG_ID)
      .eq("variety_id", variety.id)
      .eq("year", cardMid.isoYear)
      .eq("week", cardMid.isoWeek)
      .single();
    const totalAfterRetry = Object.values(entryAfterRetry!.size_kg as Record<string, number>).reduce((s, v) => s + v, 0);
    assert.equal(totalAfterRetry, 35, "a retry must never double the total");

    // A LATER new lot for the same variety/week safely appends.
    const csvC = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lotC", "Class 1", "SM", 8, variety.name, "27082026")}\n`;
    const { sourceFileId: sourceFileIdC } = await uploadAndStage(DENVA_ORG_ID, `${prefix}-c.csv`, csvC, template.id);
    const laterCards = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const laterCard = laterCards.cards.find((c) => c.varietyId === variety.id)!;
    assert.equal(laterCard.lotCount, 1);
    const laterResult = await importWeeklyCard(DENVA_ORG_ID, TEST_USER_ID, laterCard.cardKey);
    assert.equal(laterResult.results[0].mode, "append");

    const { data: finalEntry } = await supabase
      .from("yield_entries")
      .select("size_kg")
      .eq("organization_id", DENVA_ORG_ID)
      .eq("variety_id", variety.id)
      .eq("year", cardMid.isoYear)
      .eq("week", cardMid.isoWeek)
      .single();
    const finalTotal = Object.values(finalEntry!.size_kg as Record<string, number>).reduce((s, v) => s + v, 0);
    assert.equal(finalTotal, 43); // 35 + 8, combined weekly total
    await supabase.from("csv_import_source_files").delete().eq("id", sourceFileIdC);
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByPrefix(DENVA_ORG_ID, prefix),
      () => cleanupVarietyAndEntries(DENVA_ORG_ID, variety.id),
      () => cleanupYieldSize(smallSize.id)
    );
  }
});

test("resolve labels: a create-new-size resolution follows duplicate-name validation — reuses an existing size by normalized name instead of creating a near-duplicate", async () => {
  const marker = randomUUID();
  const prefix = `wc-create-size-${marker}`;
  const variety = await createTestVariety(DENVA_ORG_ID, `WcCreateSizeVariety-${marker}`);
  const smallSize = await createTestYieldSize(DENVA_ORG_ID, `WcCreateSizeSmall-${marker}`);
  const existingSize = await createTestYieldSize(DENVA_ORG_ID, `WcCreateSizeGreen-${marker}`);

  const csv = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lot1", "Class 1", "SM", 10, variety.name, "25082026")}\n${csvRow("lot1", "Class 1", "Green", 5, variety.name, "25082026")}\n`;
  const uploaded = await parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, templateBody(uploaded.sourceFileId, `WcCreateSizeTemplate-${marker}`, smallSize.id));
  await createPendingCsvTemplateImport(DENVA_ORG_ID, uploaded.sourceFileId, `${prefix}.csv`, template.id, false);

  try {
    // Same name but different case/whitespace — must reuse existingSize, not create a duplicate.
    await resolvePendingLabelsForSources(DENVA_ORG_ID, TEST_USER_ID, [uploaded.sourceFileId], [
      { sourceField: "size_label", rawValue: "Green", action: "create", newSizeName: `  ${existingSize.name.toUpperCase()}  ` }
    ]);

    const { data: matchingSizes } = await supabase
      .from("yield_sizes")
      .select("id")
      .eq("organization_id", DENVA_ORG_ID)
      .ilike("name", existingSize.name);
    assert.equal((matchingSizes ?? []).length, 1, "must not have created a case/whitespace duplicate of an existing size");

    const { cards } = await listPendingCsvTemplateWeeklyCards(DENVA_ORG_ID);
    const card = cards.find((c) => c.varietyId === variety.id)!;
    assert.equal(card.sizeKg[existingSize.name], 5);
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByPrefix(DENVA_ORG_ID, prefix),
      () => cleanupVarietyAndEntries(DENVA_ORG_ID, variety.id),
      () => cleanupYieldSize(smallSize.id),
      () => cleanupYieldSize(existingSize.id)
    );
  }
});

test("cross-organization isolation: one org's pending sources, overrides and weekly cards are never visible or resolvable from another org", async () => {
  const marker = randomUUID();
  const prefix = `wc-isolation-${marker}`;
  const variety = await createTestVariety(DENVA_ORG_ID, `WcIsolationVariety-${marker}`);
  const smallSize = await createTestYieldSize(DENVA_ORG_ID, `WcIsolationSmall-${marker}`);

  const csv = `Lot,Market,Size,Kg,Variety,Date\n${csvRow("lot1", "Class 1", "SM", 10, variety.name, "25082026")}\n${csvRow("lot1", "Class 1", "Green", 5, variety.name, "25082026")}\n`;
  const uploaded = await parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, templateBody(uploaded.sourceFileId, `WcIsolationTemplate-${marker}`, smallSize.id));
  await createPendingCsvTemplateImport(DENVA_ORG_ID, uploaded.sourceFileId, `${prefix}.csv`, template.id, false);

  try {
    const { cards: firstLightCards } = await listPendingCsvTemplateWeeklyCards(FIRST_LIGHT_ORG_ID);
    assert.ok(!firstLightCards.some((c) => c.varietyId === variety.id), "Denva's card must not leak into First Light's list");

    // Resolving under the WRONG org must not find Denva's template/source.
    await assert.rejects(() => resolveLabelsForTemplate(FIRST_LIGHT_ORG_ID, TEST_USER_ID, template.id, [
      { sourceField: "size_label", rawValue: "Green", action: "ignore" }
    ]));

    // A pending-only resolution scoped to the wrong org must be rejected
    // outright — the source file id is real, just not First Light's, and
    // the server must never trust a client-supplied id without checking
    // organization ownership first.
    await assert.rejects(
      () =>
        resolvePendingLabelsForSources(FIRST_LIGHT_ORG_ID, TEST_USER_ID, [uploaded.sourceFileId], [
          { sourceField: "size_label", rawValue: "Green", action: "ignore" }
        ]),
      TemplateValidationError
    );
    const { data: overrideRows } = await supabase
      .from("csv_source_value_overrides")
      .select("id")
      .eq("source_file_id", uploaded.sourceFileId);
    assert.equal((overrideRows ?? []).length, 0, "the rejected cross-org resolution must not have created a real override row");
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByPrefix(DENVA_ORG_ID, prefix),
      () => cleanupVarietyAndEntries(DENVA_ORG_ID, variety.id),
      () => cleanupYieldSize(smallSize.id)
    );
  }
});
