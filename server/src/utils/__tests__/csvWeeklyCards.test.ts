import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWeeklyCards, type PendingSourceEntry, type VarietyMatch } from "../csvWeeklyCards";
import type { NormalizedGroup, NormalizedRow, NormalizedPreview, ValidationIssue } from "../csvTemplateTypes";

const ORG_ID = "org-1";

function row(overrides: Partial<NormalizedRow> = {}): NormalizedRow {
  return {
    rowIndex: 0,
    action: "included",
    sizeLabelRaw: "SM",
    marketGradeRaw: "Class 1",
    sizeWeightKg: 10,
    pieceCount: 100,
    averageFruitWeightG: 100,
    matchedRuleId: null,
    resolvedSizeName: "SM",
    parseErrors: [],
    ...overrides
  };
}

function group(overrides: Partial<NormalizedGroup> = {}): NormalizedGroup {
  const rows = overrides.rows ?? [row()];
  const sizeKg = overrides.sizeKg ?? { SM: 10 };
  return {
    groupKey: "group-1",
    varietyRaw: "Cadalora",
    packedDate: "2026-08-25",
    isoYear: 2026,
    isoWeek: 35,
    lotNumber: "2608250378",
    runNumber: null,
    sizeKg,
    unresolvedSizeLabels: [],
    wasteKg: 0,
    pieceCount: 100,
    averageFruitWeightG: 100,
    totalLotWeightKg: null,
    reconciliation: {
      rawRowWeightKg: 10,
      recognizedSizeKg: 10,
      directMappedKg: 10,
      distributedKg: 0,
      ignoredKg: 0,
      unresolvedKg: 0,
      subtotalKg: 0,
      lotTotalKg: null,
      difference: 0,
      unexplainedDifference: false
    },
    rows,
    ...overrides
  };
}

function preview(groups: NormalizedGroup[], validationIssues: ValidationIssue[] = []): NormalizedPreview {
  return { groups, validationIssues, canImport: validationIssues.length === 0 };
}

function entry(overrides: Partial<PendingSourceEntry> & { preview: NormalizedPreview }): PendingSourceEntry {
  return {
    pendingImportId: "pending-1",
    sourceFileId: "source-1",
    sourceFilename: "lot-2608250378.csv",
    uploadedAt: "2026-08-26T12:00:00.000Z",
    templateId: "template-1",
    templateName: "Aweta CSV Imports",
    templateVersion: 2,
    layoutMismatch: false,
    ...overrides
  };
}

const activeVarieties: Map<string, VarietyMatch> = new Map([["cadalora", { id: "variety-cadalora", name: "Cadalora" }]]);

test("two files with the same variety/year/week but different lots and dates form one card", () => {
  const e1 = entry({
    pendingImportId: "p1",
    sourceFileId: "s1",
    sourceFilename: "lot-2608250378.csv",
    preview: preview([group({ groupKey: "g1", lotNumber: "2608250378", packedDate: "2026-08-25" })])
  });
  const e2 = entry({
    pendingImportId: "p2",
    sourceFileId: "s2",
    sourceFilename: "lot-2608260379.csv",
    preview: preview([group({ groupKey: "g2", lotNumber: "2608260379", packedDate: "2026-08-26" })])
  });

  const cards = buildWeeklyCards(ORG_ID, [e1, e2], activeVarieties);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].lotCount, 2);
  assert.equal(cards[0].sourceFileCount, 2);
  assert.deepEqual(
    cards[0].lots.map((l) => l.lotNumber).sort(),
    ["2608250378", "2608260379"]
  );
});

test("the same variety in different weeks forms separate cards", () => {
  const e1 = entry({ preview: preview([group({ groupKey: "g1", isoWeek: 35 })]) });
  const e2 = entry({
    pendingImportId: "p2",
    sourceFileId: "s2",
    preview: preview([group({ groupKey: "g2", isoWeek: 36 })])
  });

  const cards = buildWeeklyCards(ORG_ID, [e1, e2], activeVarieties);
  assert.equal(cards.length, 2);
  assert.deepEqual(
    cards.map((c) => c.isoWeek).sort(),
    [35, 36]
  );
});

test("different varieties in the same week remain separate", () => {
  const e1 = entry({ preview: preview([group({ groupKey: "g1", varietyRaw: "Cadalora" })]) });
  const e2 = entry({
    pendingImportId: "p2",
    sourceFileId: "s2",
    preview: preview([group({ groupKey: "g2", varietyRaw: "Other" })])
  });

  const cards = buildWeeklyCards(ORG_ID, [e1, e2], activeVarieties);
  assert.equal(cards.length, 2);
});

test("size kg totals equal the sum of all represented normalized contributions", () => {
  const e1 = entry({
    preview: preview([group({ groupKey: "g1", sizeKg: { SM: 10, MD: 20 } })])
  });
  const e2 = entry({
    pendingImportId: "p2",
    sourceFileId: "s2",
    preview: preview([group({ groupKey: "g2", sizeKg: { SM: 5, LG: 15 } })])
  });

  const cards = buildWeeklyCards(ORG_ID, [e1, e2], activeVarieties);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].sizeKg, { SM: 15, MD: 20, LG: 15 });
});

test("weekly total equals the sum of mapped sizes", () => {
  const e1 = entry({ preview: preview([group({ groupKey: "g1", sizeKg: { SM: 10, MD: 20 }, reconciliation: { ...group().reconciliation, recognizedSizeKg: 30 } })]) });
  const cards = buildWeeklyCards(ORG_ID, [e1], activeVarieties);
  const sumOfSizes = Object.values(cards[0].sizeKg).reduce((s, v) => s + v, 0);
  assert.equal(cards[0].mappedKg, sumOfSizes);
});

test("combined AFW uses total included kg and pieces, not an average of AFWs", () => {
  // File A: 10kg/100pcs @ AFW 100g. File B: 30kg/150pcs @ AFW 200g.
  // A naive average of (100+200)/2 = 150g would be wrong.
  // Correct: (10+30)*1000 / (100+150) = 160g.
  const e1 = entry({
    preview: preview([
      group({
        groupKey: "g1",
        rows: [row({ sizeWeightKg: 10, pieceCount: 100, averageFruitWeightG: 100 })],
        averageFruitWeightG: 100
      })
    ])
  });
  const e2 = entry({
    pendingImportId: "p2",
    sourceFileId: "s2",
    preview: preview([
      group({
        groupKey: "g2",
        rows: [row({ sizeWeightKg: 30, pieceCount: 150, averageFruitWeightG: 200 })],
        averageFruitWeightG: 200
      })
    ])
  });

  const cards = buildWeeklyCards(ORG_ID, [e1, e2], activeVarieties);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].combinedAverageFruitWeightG, 160);
});

test("ignored rows do not contribute to AFW", () => {
  const e1 = entry({
    preview: preview([
      group({
        groupKey: "g1",
        rows: [
          row({ sizeWeightKg: 10, pieceCount: 100, averageFruitWeightG: 100, action: "included" }),
          // A huge ignored row that would badly skew AFW if it leaked in.
          row({ sizeWeightKg: 1000, pieceCount: 1, averageFruitWeightG: 999999, action: "ignored" })
        ]
      })
    ])
  });

  const cards = buildWeeklyCards(ORG_ID, [e1], activeVarieties);
  assert.equal(cards[0].combinedAverageFruitWeightG, 100);
});

test("lot numbers, packed dates and filenames remain traceable", () => {
  const e1 = entry({
    pendingImportId: "p1",
    sourceFileId: "s1",
    sourceFilename: "lot-2608250378.csv",
    preview: preview([group({ groupKey: "g1", lotNumber: "2608250378", packedDate: "2026-08-25" })])
  });
  const cards = buildWeeklyCards(ORG_ID, [e1], activeVarieties);
  const card = cards[0];
  assert.equal(card.lots[0].lotNumber, "2608250378");
  assert.equal(card.lots[0].packedDate, "2026-08-25");
  assert.equal(card.sources[0].sourceFilename, "lot-2608250378.csv");
  assert.equal(card.sources[0].pendingImportId, "p1");
  assert.equal(card.sources[0].sourceFileId, "s1");
});

test("identical unresolved labels are grouped with correct kg/piece totals", () => {
  const e1 = entry({
    pendingImportId: "p1",
    sourceFileId: "s1",
    sourceFilename: "lot-a.csv",
    preview: preview([
      group({
        groupKey: "g1",
        lotNumber: "lot-a",
        rows: [
          row({ action: "included" }),
          row({ action: "unresolved", sizeLabelRaw: "Green", sizeWeightKg: 315.2, pieceCount: 40 })
        ]
      })
    ])
  });
  const e2 = entry({
    pendingImportId: "p2",
    sourceFileId: "s2",
    sourceFilename: "lot-b.csv",
    preview: preview([
      group({
        groupKey: "g2",
        lotNumber: "lot-b",
        rows: [row({ action: "unresolved", sizeLabelRaw: "green", sizeWeightKg: 100, pieceCount: 10 })]
      })
    ])
  });

  const cards = buildWeeklyCards(ORG_ID, [e1, e2], activeVarieties);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].unresolvedLabelGroups.length, 1);
  const greenGroup = cards[0].unresolvedLabelGroups[0];
  assert.equal(greenGroup.rowCount, 2);
  assert.equal(greenGroup.kg, 415.2);
  assert.equal(greenGroup.pieceCount, 50);
  assert.deepEqual(greenGroup.lotNumbers.sort(), ["lot-a", "lot-b"]);
  assert.deepEqual(greenGroup.sourceFilenames.sort(), ["lot-a.csv", "lot-b.csv"]);
});

test("a group-level blocking issue keeps the card from being importable", () => {
  const e1 = entry({
    preview: preview(
      [group({ groupKey: "g1" })],
      [{ code: "unresolved_size_label", message: "Unresolved label", groupKey: "g1" }]
    )
  });
  const cards = buildWeeklyCards(ORG_ID, [e1], activeVarieties);
  assert.equal(cards[0].canImport, false);
  assert.equal(cards[0].blockingIssues.length, 1);
});

test("an unresolved (unmatched) variety still forms a card but with a null varietyId", () => {
  const e1 = entry({ preview: preview([group({ groupKey: "g1", varietyRaw: "Unknownberry" })]) });
  const cards = buildWeeklyCards(ORG_ID, [e1], activeVarieties);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].varietyId, null);
  assert.equal(cards[0].varietyName, "Unknownberry");
});
