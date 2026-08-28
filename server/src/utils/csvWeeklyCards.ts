// Pure aggregation logic for the CSV-template Pending CSV Imports "weekly
// variety card" view — groups already-normalized per-source previews
// (produced by the same engine/buildCsvPreview path used for the final
// import, never recalculated independently here) by
// (organization, resolved variety, production year, production week).
//
// Deliberately has zero DB/network calls so it is directly unit-testable:
// callers (csvMappingTemplates.ts) do the fetching/preview-building and
// hand this module plain data.

import type { NormalizedGroup, NormalizedPreview, ValidationIssue } from "./csvTemplateTypes";

export type PendingSourceEntry = {
  pendingImportId: string;
  sourceFileId: string;
  sourceFilename: string;
  uploadedAt: string;
  templateId: string;
  templateName: string | null;
  templateVersion: number | null;
  layoutMismatch: boolean;
  preview: NormalizedPreview;
};

export type VarietyMatch = { id: string; name: string; areaM2: number | null };

export type UnresolvedLabelGroup = {
  rawValue: string;
  rowCount: number;
  kg: number;
  pieceCount: number;
  lotNumbers: string[];
  sourceFilenames: string[];
  sourceFileIds: string[];
  pendingImportIds: string[];
};

export type WeeklyCardLot = {
  lotNumber: string | null;
  packedDate: string | null;
};

export type WeeklyCardSourceDetail = {
  pendingImportId: string;
  sourceFileId: string;
  sourceFilename: string;
  uploadedAt: string;
  templateId: string;
  templateName: string | null;
  templateVersion: number | null;
  matchStatus: "exact" | "layout_mismatch";
  lotNumber: string | null;
  packedDate: string | null;
  mappedKg: number;
  sizeKg: Record<string, number>;
  averageFruitWeightG: number | null;
  reconciliationOk: boolean;
  unresolvedLabels: string[];
  blockingIssues: ValidationIssue[];
};

export type WeeklyCard = {
  cardKey: string;
  organizationId: string;
  varietyId: string | null;
  varietyName: string;
  isoYear: number | null;
  isoWeek: number | null;
  mappedKg: number;
  lotCount: number;
  sourceFileCount: number;
  templateNames: string[];
  matchStatus: "exact" | "mixed" | "layout_mismatch";
  combinedAverageFruitWeightG: number | null;
  ignoredKg: number;
  distributedKg: number;
  unresolvedKg: number;
  reconciliationDifference: number;
  reconciliationOk: boolean;
  /** mappedKg / the resolved variety's area_m2 — same "valid area" rule as Yield Analytics (area_m2 > 0). Null when the variety is unresolved or has no valid positive area; the client shows "Area not set" rather than 0 or a divide-by-zero. */
  kgPerM2: number | null;
  lots: WeeklyCardLot[];
  sizeKg: Record<string, number>;
  unresolvedLabelGroups: UnresolvedLabelGroup[];
  canImport: boolean;
  blockingIssues: ValidationIssue[];
  sources: WeeklyCardSourceDetail[];
};

function resolveVariety(
  varietyRaw: string | null,
  activeVarietyByName: Map<string, VarietyMatch>
): { key: string; id: string | null; name: string; areaM2: number | null } {
  const trimmed = (varietyRaw ?? "").trim();
  const match = trimmed ? activeVarietyByName.get(trimmed.toLowerCase()) : undefined;
  if (match) return { key: match.id, id: match.id, name: match.name, areaM2: match.areaM2 };
  return { key: `raw:${trimmed.toLowerCase() || "unknown"}`, id: null, name: trimmed || "Unknown variety", areaM2: null };
}

function groupBlockingIssues(preview: NormalizedPreview, group: NormalizedGroup): ValidationIssue[] {
  return preview.validationIssues.filter((i) => !i.groupKey || i.groupKey === group.groupKey);
}

function includedTotals(group: NormalizedGroup): { kg: number; pieces: number } {
  let kg = 0;
  let pieces = 0;
  for (const row of group.rows) {
    if (row.action !== "included") continue;
    kg += row.sizeWeightKg ?? 0;
    pieces += row.pieceCount ?? 0;
  }
  return { kg, pieces };
}

function unresolvedRowsOf(group: NormalizedGroup): Array<{ rawValue: string; kg: number; pieces: number }> {
  const out: Array<{ rawValue: string; kg: number; pieces: number }> = [];
  for (const row of group.rows) {
    if (row.action !== "unresolved" || !row.sizeLabelRaw) continue;
    out.push({ rawValue: row.sizeLabelRaw.trim(), kg: row.sizeWeightKg ?? 0, pieces: row.pieceCount ?? 0 });
  }
  return out;
}

/**
 * Builds weekly variety cards from a flat list of already-fetched pending
 * source previews. Each source can contribute to more than one card if its
 * file contains multiple groups spanning different weeks/varieties — every
 * group is attributed to exactly one card, based on ITS OWN resolved
 * variety/year/week, never the file's as a whole.
 */
export function buildWeeklyCards(
  organizationId: string,
  entries: PendingSourceEntry[],
  activeVarietyByName: Map<string, VarietyMatch>
): WeeklyCard[] {
  type Bucket = {
    varietyId: string | null;
    varietyName: string;
    areaM2: number | null;
    isoYear: number | null;
    isoWeek: number | null;
    mappedKg: number;
    includedKg: number;
    includedPieces: number;
    ignoredKg: number;
    distributedKg: number;
    unresolvedKg: number;
    reconciliationDifference: number;
    reconciliationOk: boolean;
    lots: Map<string, WeeklyCardLot>;
    sizeKg: Record<string, number>;
    templateNameVersions: Set<string>;
    hasLayoutMismatch: boolean;
    unresolvedLabelGroups: Map<string, UnresolvedLabelGroup>;
    blockingIssues: ValidationIssue[];
    sources: Map<string, WeeklyCardSourceDetail>;
  };

  const buckets = new Map<string, Bucket>();

  for (const entry of entries) {
    for (const group of entry.preview.groups) {
      const variety = resolveVariety(group.varietyRaw, activeVarietyByName);
      const cardKey = `${organizationId}:${variety.key}:${group.isoYear ?? "none"}:${group.isoWeek ?? "none"}`;

      let bucket = buckets.get(cardKey);
      if (!bucket) {
        bucket = {
          varietyId: variety.id,
          varietyName: variety.name,
          areaM2: variety.areaM2,
          isoYear: group.isoYear,
          isoWeek: group.isoWeek,
          mappedKg: 0,
          includedKg: 0,
          includedPieces: 0,
          ignoredKg: 0,
          distributedKg: 0,
          unresolvedKg: 0,
          reconciliationDifference: 0,
          reconciliationOk: true,
          lots: new Map(),
          sizeKg: {},
          templateNameVersions: new Set(),
          hasLayoutMismatch: false,
          unresolvedLabelGroups: new Map(),
          blockingIssues: [],
          sources: new Map()
        };
        buckets.set(cardKey, bucket);
      }

      const groupIssues = groupBlockingIssues(entry.preview, group);
      const included = includedTotals(group);

      bucket.mappedKg += group.reconciliation.recognizedSizeKg;
      bucket.includedKg += included.kg;
      bucket.includedPieces += included.pieces;
      bucket.ignoredKg += group.reconciliation.ignoredKg;
      bucket.distributedKg += group.reconciliation.distributedKg;
      bucket.unresolvedKg += group.reconciliation.unresolvedKg;
      if (group.reconciliation.difference !== null) {
        bucket.reconciliationDifference += group.reconciliation.difference;
      }
      if (group.reconciliation.unexplainedDifference) bucket.reconciliationOk = false;

      const lotKey = `${group.lotNumber ?? ""}::${group.packedDate ?? ""}`;
      if (!bucket.lots.has(lotKey)) {
        bucket.lots.set(lotKey, { lotNumber: group.lotNumber, packedDate: group.packedDate });
      }

      for (const [sizeName, kg] of Object.entries(group.sizeKg)) {
        bucket.sizeKg[sizeName] = (bucket.sizeKg[sizeName] ?? 0) + kg;
      }

      bucket.templateNameVersions.add(`${entry.templateName ?? "Unknown"}::${entry.templateVersion ?? "?"}`);
      if (entry.layoutMismatch) bucket.hasLayoutMismatch = true;
      bucket.blockingIssues.push(...groupIssues);

      for (const row of unresolvedRowsOf(group)) {
        const labelKey = row.rawValue.toLowerCase();
        let labelGroup = bucket.unresolvedLabelGroups.get(labelKey);
        if (!labelGroup) {
          labelGroup = {
            rawValue: row.rawValue,
            rowCount: 0,
            kg: 0,
            pieceCount: 0,
            lotNumbers: [],
            sourceFilenames: [],
            sourceFileIds: [],
            pendingImportIds: []
          };
          bucket.unresolvedLabelGroups.set(labelKey, labelGroup);
        }
        labelGroup.rowCount += 1;
        labelGroup.kg += row.kg;
        labelGroup.pieceCount += row.pieces;
        if (group.lotNumber && !labelGroup.lotNumbers.includes(group.lotNumber)) labelGroup.lotNumbers.push(group.lotNumber);
        if (!labelGroup.sourceFilenames.includes(entry.sourceFilename)) labelGroup.sourceFilenames.push(entry.sourceFilename);
        if (!labelGroup.sourceFileIds.includes(entry.sourceFileId)) labelGroup.sourceFileIds.push(entry.sourceFileId);
        if (!labelGroup.pendingImportIds.includes(entry.pendingImportId)) labelGroup.pendingImportIds.push(entry.pendingImportId);
      }

      const sourceKey = `${entry.pendingImportId}`;
      const existingSource = bucket.sources.get(sourceKey);
      const unresolvedLabelsForGroup = Array.from(new Set(unresolvedRowsOf(group).map((r) => r.rawValue)));
      if (!existingSource) {
        bucket.sources.set(sourceKey, {
          pendingImportId: entry.pendingImportId,
          sourceFileId: entry.sourceFileId,
          sourceFilename: entry.sourceFilename,
          uploadedAt: entry.uploadedAt,
          templateId: entry.templateId,
          templateName: entry.templateName,
          templateVersion: entry.templateVersion,
          matchStatus: entry.layoutMismatch ? "layout_mismatch" : "exact",
          lotNumber: group.lotNumber,
          packedDate: group.packedDate,
          mappedKg: group.reconciliation.recognizedSizeKg,
          sizeKg: { ...group.sizeKg },
          averageFruitWeightG: group.averageFruitWeightG,
          reconciliationOk: !group.reconciliation.unexplainedDifference,
          unresolvedLabels: unresolvedLabelsForGroup,
          blockingIssues: groupIssues
        });
      } else {
        // Same source contributed a second group to the SAME card (e.g. two
        // lots for this variety/week in one file) — merge into one source row.
        existingSource.mappedKg += group.reconciliation.recognizedSizeKg;
        for (const [sizeName, kg] of Object.entries(group.sizeKg)) {
          existingSource.sizeKg[sizeName] = (existingSource.sizeKg[sizeName] ?? 0) + kg;
        }
        existingSource.reconciliationOk = existingSource.reconciliationOk && !group.reconciliation.unexplainedDifference;
        for (const label of unresolvedLabelsForGroup) {
          if (!existingSource.unresolvedLabels.includes(label)) existingSource.unresolvedLabels.push(label);
        }
        existingSource.blockingIssues.push(...groupIssues);
      }
    }
  }

  const cards: WeeklyCard[] = [];
  for (const [cardKey, bucket] of buckets.entries()) {
    const distinctTemplates = Array.from(bucket.templateNameVersions).map((s) => {
      const [name, version] = s.split("::");
      return version === "?" ? name : `${name} (v${version})`;
    });
    const matchStatus: WeeklyCard["matchStatus"] = bucket.hasLayoutMismatch
      ? "layout_mismatch"
      : distinctTemplates.length > 1
        ? "mixed"
        : "exact";

    cards.push({
      cardKey,
      organizationId,
      varietyId: bucket.varietyId,
      varietyName: bucket.varietyName,
      isoYear: bucket.isoYear,
      isoWeek: bucket.isoWeek,
      mappedKg: Math.round(bucket.mappedKg * 100) / 100,
      lotCount: bucket.lots.size,
      sourceFileCount: bucket.sources.size,
      templateNames: distinctTemplates,
      matchStatus,
      combinedAverageFruitWeightG: bucket.includedPieces > 0 ? (bucket.includedKg * 1000) / bucket.includedPieces : null,
      ignoredKg: Math.round(bucket.ignoredKg * 100) / 100,
      distributedKg: Math.round(bucket.distributedKg * 100) / 100,
      unresolvedKg: Math.round(bucket.unresolvedKg * 100) / 100,
      reconciliationDifference: Math.round(bucket.reconciliationDifference * 100) / 100,
      reconciliationOk: bucket.reconciliationOk,
      kgPerM2:
        bucket.areaM2 !== null && bucket.areaM2 > 0 ? Math.round((bucket.mappedKg / bucket.areaM2) * 1000) / 1000 : null,
      lots: Array.from(bucket.lots.values()),
      sizeKg: bucket.sizeKg,
      unresolvedLabelGroups: Array.from(bucket.unresolvedLabelGroups.values()),
      canImport: bucket.blockingIssues.length === 0,
      blockingIssues: bucket.blockingIssues,
      sources: Array.from(bucket.sources.values())
    });
  }

  cards.sort((a, b) => {
    if (a.varietyName !== b.varietyName) return a.varietyName.localeCompare(b.varietyName);
    if ((a.isoYear ?? 0) !== (b.isoYear ?? 0)) return (b.isoYear ?? 0) - (a.isoYear ?? 0);
    return (b.isoWeek ?? 0) - (a.isoWeek ?? 0);
  });

  return cards;
}
