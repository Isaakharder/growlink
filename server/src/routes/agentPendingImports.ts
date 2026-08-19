import { Router } from "express";
import { supabase } from "../config/supabase";
import { loadOrgSizeContext } from "./pdfImport";
import { resolveFileSizes, type OrgSizeContext } from "../utils/sizeMapping";
import { parseFlowMasterCsv, type CsvSizeEntry, type CsvRowKg, type FlowMasterParseResult } from "../utils/flowMasterCsvParser";
import { resolveCsvRowLabels } from "../utils/flowMasterCsvRuleResolver";
import { fetchCsvSizeSettings, type CsvSizeSettings } from "../utils/csvSizeSettings";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

const agentPendingImportsRouter = Router();

const canView = requireAnyPermission(["yield:view", "yield:edit"]);
const canEdit = requirePermission("yield:edit");

const PENDING_IMPORT_COLUMNS =
  "id, lot_number, variety_name, source_filename, start_time, iso_year, iso_week, average_fruit_weight_g, size_kg, parsed_total_kg, warnings, unknown_sizes, raw_payload, needs_template, data_source_type, override_variety_id";

export type PendingImportRow = {
  id: string;
  lot_number: string | null;
  variety_name: string | null;
  source_filename: string;
  start_time: string | null;
  iso_year: number | null;
  iso_week: number | null;
  average_fruit_weight_g: number | null;
  size_kg: Record<string, unknown>;
  parsed_total_kg: number | null;
  warnings: unknown[];
  unknown_sizes: unknown[];
  raw_payload: Record<string, unknown> | null;
  needs_template: boolean;
  data_source_type: string;
  override_variety_id: string | null;
};

type ActiveVariety = { id: string; name: string };
type ExistingYieldEntry = { variety_id: string; year: number; week: number };
type ExistingImportRun = { lot_number: string };

type PdfPreviewSuccess = {
  id: string;
  filename: string;
  success: true;
  lotNumber: string | null;
  alreadyImported: boolean;
  skipped: boolean;
  variety: string | null;
  overrideVarietyId: string | null;
  isOverridden: boolean;
  matchedVariety: {
    found: boolean;
    varietyId: string | null;
    varietyName: string | null;
  };
  startTime: string | null;
  startDate: string | null;
  isoWeek: number | null;
  isoYear: number | null;
  totalKg: number | null;
  averageFruitWeightG: number | null;
  sizeBreakdown: Record<string, number>;
  sizeMappingStatus: {
    mappedCount: number;
    unmappedCount: number;
    mapped: Array<{ pdfSize: string; growlinkSize: string }>;
    unmapped: string[];
  };
  duplicateStatus: { found: boolean };
  unknownSizes: string[];
  warnings: string[];
  csvSizes: CsvSizeEntry[];
  needsTemplate: boolean;
  dataSourceType: string;
  csvHeaders: string[];
};

export type BuildPreviewContext = {
  activeVarietyByName: Map<string, ActiveVariety>;
  activeVarietyById: Map<string, ActiveVariety>;
  sizeContext: OrgSizeContext;
  csvSettings: CsvSizeSettings;
  existingEntryKeySet: Set<string>;
  alreadyImportedLots: Set<string>;
};

type BuildContextResult =
  | { ok: true; ctx: BuildPreviewContext }
  | { ok: false; error: string };

// Shared by GET (batch) and PATCH (single row) so both resolve variety
// matching, size mapping and duplicate-week detection identically —
// including preferring override_variety_id over the raw parsed variety_name.
export function buildPreviewFile(row: PendingImportRow, ctx: BuildPreviewContext): PdfPreviewSuccess {
  // If the raw CSV text was captured at upload time (raw_payload.csv_text —
  // see agentRoutes.ts), fully re-parse it now instead of trusting ANY of
  // the stored columns (size_kg, warnings, start_time, iso_year/iso_week,
  // parsed_total_kg, average_fruit_weight_g). Those were frozen at whatever
  // the parser produced the moment this row was queued — if a parser fix
  // (duplicate-header handling, date parsing, MARKET/SIZE1 priority, etc.)
  // shipped after that, the stored columns stay wrong forever without this.
  // Rows queued before raw CSV text was captured fall back to the stored
  // columns below (best-effort — the original bytes are gone, so a full
  // re-parse isn't possible; only sizeKg can be partially corrected via
  // csvRowKg, see further down).
  const rawCsvText = row.raw_payload?.csv_text;
  let freshParsed: FlowMasterParseResult | null = null;
  if (typeof rawCsvText === "string" && row.lot_number) {
    try {
      const reparsed = parseFlowMasterCsv(
        rawCsvText,
        row.source_filename,
        ctx.csvSettings.ignoredSizeLabels,
        ctx.csvSettings.sizeAliases
      );
      freshParsed = reparsed.find((r) => r.lotNumber === row.lot_number) ?? null;
    } catch {
      // Fall back to stored columns below — a re-parse failure here must
      // never break the review UI.
      freshParsed = null;
    }
  }

  const baseWarnings: unknown[] = freshParsed ? freshParsed.warnings : row.warnings;

  // Drop the parser's own "New size found" warnings — they don't know about
  // saved size rules, so a label a rule has since resolved would otherwise
  // still show a stale "unknown" warning below alongside (or instead of) the
  // correctly-resolved one. Mirrors pdfImport.ts's /pdf-import/preview,
  // which filters the same way for the same reason.
  const warnings: string[] = Array.isArray(baseWarnings)
    ? (baseWarnings as string[]).filter((w) => typeof w === "string" && !w.startsWith("New size found:"))
    : [];

  const alreadyImported = row.lot_number !== null && ctx.alreadyImportedLots.has(row.lot_number);
  const skipped = alreadyImported;

  if (alreadyImported) {
    warnings.push(`Lot ${row.lot_number} was already imported and will be skipped.`);
  }

  const isOverridden = row.override_variety_id !== null;
  const overrideVariety = row.override_variety_id
    ? ctx.activeVarietyById.get(row.override_variety_id) ?? null
    : null;
  const nameMatchedVariety =
    row.variety_name !== null ? ctx.activeVarietyByName.get(row.variety_name) ?? null : null;
  const matchedVariety = overrideVariety ?? nameMatchedVariety;

  if (isOverridden && !overrideVariety) {
    warnings.push("Overridden variety is no longer active. Reassign again.");
  } else if (!isOverridden && row.variety_name && !matchedVariety) {
    warnings.push(
      `Variety not found: ${row.variety_name}. Add or rename variety before importing.`
    );
  }

  // csvRowKg carries the per-row MARKET/SIZE1/kg facts needed to redo size
  // resolution with the org's CURRENT saved flowmaster_size_rules factored
  // into MARKET-vs-SIZE1 priority (a MARKET rule can outrank a direct SIZE1
  // code — see flowMasterCsvRuleResolver.ts). Prefer freshParsed's (always
  // correct, this instant) over whatever raw_payload happened to store at
  // upload time; fall back to the stored columns only when neither is usable
  // (e.g. a PDF row, or a CSV row queued before either field existed).
  const rawCsvRowKg = freshParsed ? freshParsed.csvRowKg : row.raw_payload?.csvRowKg;
  const csvRowKg: CsvRowKg[] = Array.isArray(rawCsvRowKg)
    ? (rawCsvRowKg as unknown[]).filter(
        (r): r is CsvRowKg =>
          r !== null &&
          typeof r === "object" &&
          typeof (r as CsvRowKg).marketLabel === "string" &&
          typeof (r as CsvRowKg).size1Label === "string" &&
          typeof (r as CsvRowKg).kg === "number"
      )
    : [];

  let sizeBreakdown: Record<string, number>;
  let unknownSizesSeed: string[];

  if (csvRowKg.length > 0) {
    const reResolved = resolveCsvRowLabels(
      csvRowKg,
      ctx.csvSettings.ignoredSizeLabels,
      ctx.csvSettings.sizeAliases,
      ctx.sizeContext.rulesByNormalizedLabel
    );
    sizeBreakdown = reResolved.sizeKg;
    unknownSizesSeed = reResolved.unknownSizes;
  } else {
    // Normalise size_kg from JSONB — values may be strings when deserialised from numeric
    const rawSizeKg = row.size_kg ?? {};
    sizeBreakdown = {};
    for (const [sizeName, rawKg] of Object.entries(rawSizeKg)) {
      const kg = typeof rawKg === "number" ? rawKg : Number(rawKg);
      if (Number.isFinite(kg) && kg >= 0) {
        sizeBreakdown[sizeName] = kg;
      }
    }

    unknownSizesSeed = Array.isArray(row.unknown_sizes)
      ? (row.unknown_sizes as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
  }

  const resolved = resolveFileSizes(sizeBreakdown, unknownSizesSeed, ctx.sizeContext);
  warnings.push(...resolved.ruleNotes, ...resolved.sizeWarnings);

  // Effective date/week/total/AFW: freshParsed's when a re-parse succeeded,
  // otherwise whatever was stored at upload time.
  const effectiveStartTime = freshParsed ? freshParsed.startTime : row.start_time;
  const effectiveIsoYear = freshParsed ? freshParsed.isoYear : row.iso_year;
  const effectiveIsoWeek = freshParsed ? freshParsed.isoWeek : row.iso_week;
  const effectiveTotalKg = freshParsed ? freshParsed.totalKg : row.parsed_total_kg;
  const effectiveAverageFruitWeightG = freshParsed ? freshParsed.averageFruitWeightG : row.average_fruit_weight_g;

  const duplicateKey =
    matchedVariety && effectiveIsoYear !== null && effectiveIsoWeek !== null
      ? `${matchedVariety.id}::${effectiveIsoYear}::${effectiveIsoWeek}`
      : null;

  const hasExistingWeeklyData =
    duplicateKey !== null && ctx.existingEntryKeySet.has(duplicateKey);

  if (hasExistingWeeklyData && matchedVariety) {
    warnings.push("Existing weekly data found. Import will add these PDF totals to the week.");
  }

  // csvSizes: prefer freshParsed's (always correct), else whatever raw_payload
  // stored at upload time.
  const rawCsvSizes = freshParsed ? freshParsed.csvSizes : row.raw_payload?.csvSizes;
  const csvSizes: CsvSizeEntry[] = Array.isArray(rawCsvSizes)
    ? (rawCsvSizes as unknown[]).filter(
        (e): e is CsvSizeEntry =>
          e !== null &&
          typeof e === "object" &&
          typeof (e as CsvSizeEntry).rawLabel === "string" &&
          typeof (e as CsvSizeEntry).kg === "number"
      )
    : [];

  const rawCsvHeaders = row.raw_payload?.csv_headers;
  const csvHeaders: string[] = Array.isArray(rawCsvHeaders)
    ? (rawCsvHeaders as unknown[]).filter((h): h is string => typeof h === "string")
    : [];

  return {
    id: row.id,
    filename: row.source_filename,
    success: true,
    lotNumber: row.lot_number,
    alreadyImported,
    skipped,
    variety: row.variety_name,
    overrideVarietyId: row.override_variety_id,
    isOverridden,
    matchedVariety: {
      found: Boolean(matchedVariety),
      varietyId: matchedVariety?.id ?? null,
      varietyName: matchedVariety?.name ?? null
    },
    startTime: effectiveStartTime,
    startDate: effectiveStartTime?.slice(0, 10) ?? null,
    isoWeek: effectiveIsoWeek,
    isoYear: effectiveIsoYear,
    totalKg: effectiveTotalKg,
    averageFruitWeightG: effectiveAverageFruitWeightG,
    sizeBreakdown: resolved.sizeKg,
    sizeMappingStatus: resolved.sizeMappingStatus,
    duplicateStatus: { found: hasExistingWeeklyData },
    unknownSizes: resolved.unknownSizes,
    warnings: Array.from(new Set(warnings)),
    csvSizes,
    needsTemplate: row.needs_template,
    dataSourceType: row.data_source_type,
    csvHeaders,
  };
}

// Loads the org-scoped lookup maps buildPreviewFile needs. lotNumbers scopes
// the yield_import_runs "already imported" check — pass every lot for a
// batch (GET) or just the one row's lot for a single-row rebuild (PATCH).
async function loadBuildContext(
  organizationId: string,
  lotNumbers: string[]
): Promise<BuildContextResult> {
  const [varietiesResult, yieldEntriesResult, importRunsResult, sizeContextResult, csvSettings] =
    await Promise.all([
      supabase
        .from("varieties")
        .select("id, name")
        .eq("organization_id", organizationId)
        .eq("status", "active"),
      supabase
        .from("yield_entries")
        .select("variety_id, year, week")
        .eq("organization_id", organizationId),
      lotNumbers.length > 0
        ? supabase
            .from("yield_import_runs")
            .select("lot_number")
            .eq("organization_id", organizationId)
            .in("lot_number", lotNumbers)
        : Promise.resolve({ data: [] as ExistingImportRun[], error: null }),
      loadOrgSizeContext(organizationId),
      fetchCsvSizeSettings(organizationId)
    ]);

  if (varietiesResult.error) {
    return { ok: false, error: "Failed to load varieties." };
  }
  if (yieldEntriesResult.error) {
    return { ok: false, error: "Failed to load yield entries." };
  }
  if (importRunsResult.error) {
    return { ok: false, error: "Failed to load import history." };
  }
  if (!sizeContextResult.ok) {
    return { ok: false, error: sizeContextResult.error };
  }

  const activeVarieties = (varietiesResult.data ?? []) as ActiveVariety[];
  const existingYieldEntries = (yieldEntriesResult.data ?? []) as ExistingYieldEntry[];
  const existingImportRuns = (importRunsResult.data ?? []) as ExistingImportRun[];

  const activeVarietyByName = new Map<string, ActiveVariety>();
  const activeVarietyById = new Map<string, ActiveVariety>();
  for (const v of activeVarieties) {
    activeVarietyByName.set(v.name, v);
    activeVarietyById.set(v.id, v);
  }

  const existingEntryKeySet = new Set<string>();
  for (const entry of existingYieldEntries) {
    existingEntryKeySet.add(`${entry.variety_id}::${entry.year}::${entry.week}`);
  }

  const alreadyImportedLots = new Set<string>();
  for (const run of existingImportRuns) {
    alreadyImportedLots.add(run.lot_number);
  }

  return {
    ok: true,
    ctx: {
      activeVarietyByName,
      activeVarietyById,
      sizeContext: sizeContextResult.ctx,
      csvSettings,
      existingEntryKeySet,
      alreadyImportedLots
    }
  };
}

// GET /api/agent-pending-imports[?isoYear=YYYY&isoWeek=WW]
// Returns all pending agent imports for the org in PdfPreviewFileSuccess shape
// so the client can call setPdfPreviewFiles(body.files) unchanged.
// Each item includes `id` (the pending row UUID) so the client can DELETE by id.
// `weeks` is always the full unfiltered list so the header cards stay current.
// When isoYear + isoWeek query params are present, `files` is filtered to that week only.
agentPendingImportsRouter.get("/agent-pending-imports", canView, async (req, res) => {
  const organizationId = req.organizationId;

  // Optional filter: ?dataSourceType=flowmaster restricts results to one source type.
  // KgEntriesTab passes this so it only ever sees FlowMaster imports.
  const rawDst = req.query.dataSourceType;
  const dataSourceTypeFilter = typeof rawDst === "string" && rawDst.trim() ? rawDst.trim() : null;

  let pendingQuery = supabase
    .from("agent_pending_imports")
    .select(PENDING_IMPORT_COLUMNS)
    .eq("organization_id", organizationId)
    .order("uploaded_at", { ascending: false });

  if (dataSourceTypeFilter) {
    pendingQuery = pendingQuery.eq("data_source_type", dataSourceTypeFilter);
  }
  if (dataSourceTypeFilter === "flowmaster") {
    // Exclude rows still waiting for template configuration from the FlowMaster review panel.
    pendingQuery = pendingQuery.eq("needs_template", false);
  }

  const { data: pendingRows, error: pendingError } = await pendingQuery;

  if (pendingError) {
    console.error("[agent-pending-imports] fetch failed:", {
      organizationId,
      code: pendingError.code,
      message: pendingError.message
    });
    return res.status(500).json({ message: "Failed to load pending imports." });
  }

  const rows = (pendingRows ?? []) as unknown as PendingImportRow[];

  if (rows.length === 0) {
    return res.json({ success: true, count: 0, files: [] });
  }

  const lotNumbers = rows.map((r) => r.lot_number).filter((n): n is string => n !== null);

  const contextResult = await loadBuildContext(organizationId, lotNumbers);
  if (!contextResult.ok) {
    return res.status(500).json({ message: contextResult.error });
  }

  const files: PdfPreviewSuccess[] = rows.map((row) => buildPreviewFile(row, contextResult.ctx));

  const count = files.filter((f) => !f.alreadyImported).length;

  // Build weeks metadata — one entry per (isoYear, isoWeek) pair, actionable items only.
  const weekMap = new Map<string, { isoYear: number | null; isoWeek: number | null; count: number }>();
  for (const file of files) {
    if (file.alreadyImported) continue;
    const key = `${file.isoYear ?? "null"}::${file.isoWeek ?? "null"}`;
    const existing = weekMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      weekMap.set(key, { isoYear: file.isoYear, isoWeek: file.isoWeek, count: 1 });
    }
  }
  const weeks = Array.from(weekMap.values()).sort((a, b) => {
    if (a.isoYear !== b.isoYear) return (b.isoYear ?? -1) - (a.isoYear ?? -1);
    return (b.isoWeek ?? -1) - (a.isoWeek ?? -1);
  });

  // Optional week filter — when isoYear + isoWeek are valid integers, return only that week's files.
  const rawYear = req.query.isoYear;
  const rawWeek = req.query.isoWeek;
  const filterYear = typeof rawYear === "string" ? parseInt(rawYear, 10) : NaN;
  const filterWeek = typeof rawWeek === "string" ? parseInt(rawWeek, 10) : NaN;
  const shouldFilter = Number.isFinite(filterYear) && filterYear > 0 &&
                       Number.isFinite(filterWeek) && filterWeek > 0;

  const filteredFiles = shouldFilter
    ? files.filter((f) => f.isoYear === filterYear && f.isoWeek === filterWeek)
    : files;

  return res.json({ success: true, count, weeks, files: filteredFiles });
});

// PATCH /api/agent-pending-imports/:id
// Sets or clears a manual variety override for a single pending reading —
// used when a warehouse operator forgot to change the variety on the
// FlowMaster computer, so the PDF parsed correctly but under the wrong name.
// Body: { varietyId: string | null }. null/omitted clears the override and
// reverts to the PDF-parsed name match. Returns the row rebuilt the same way
// GET does, so the client can splice it back into pdfPreviewFiles and let the
// existing grouping/aggregation logic recompute totals for both cards.
agentPendingImportsRouter.patch("/agent-pending-imports/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const rawVarietyId = (req.body as Record<string, unknown> | undefined)?.varietyId;
  let varietyId: string | null;

  if (rawVarietyId === null || rawVarietyId === undefined || rawVarietyId === "") {
    varietyId = null;
  } else if (typeof rawVarietyId === "string") {
    varietyId = rawVarietyId.trim();
  } else {
    return res.status(400).json({ message: "varietyId must be a string or null." });
  }

  if (varietyId) {
    const { data: targetVariety, error: varietyError } = await supabase
      .from("varieties")
      .select("id")
      .eq("id", varietyId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (varietyError) {
      console.error("[agent-pending-imports] override variety lookup failed:", {
        organizationId,
        varietyId,
        code: varietyError.code,
        message: varietyError.message
      });
      return res.status(500).json({ message: "Failed to validate target variety." });
    }

    if (!targetVariety) {
      return res.status(400).json({
        message: "Target variety does not belong to this organization."
      });
    }
  }

  const { data: updatedRow, error: updateError } = await supabase
    .from("agent_pending_imports")
    .update({ override_variety_id: varietyId })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select(PENDING_IMPORT_COLUMNS)
    .maybeSingle();

  if (updateError) {
    console.error("[agent-pending-imports] override update failed:", {
      id,
      organizationId,
      code: updateError.code,
      message: updateError.message
    });
    return res.status(500).json({ message: "Failed to reassign this reading." });
  }

  if (!updatedRow) {
    return res.status(404).json({ message: "Pending import not found." });
  }

  const row = updatedRow as unknown as PendingImportRow;
  const lotNumbers = row.lot_number ? [row.lot_number] : [];

  const contextResult = await loadBuildContext(organizationId, lotNumbers);
  if (!contextResult.ok) {
    return res.status(500).json({ message: contextResult.error });
  }

  return res.json({ success: true, file: buildPreviewFile(row, contextResult.ctx) });
});

// DELETE /api/agent-pending-imports/:id
// Hard-deletes a pending import row. The org_id check prevents cross-org deletion.
agentPendingImportsRouter.delete("/agent-pending-imports/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("agent_pending_imports")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("[agent-pending-imports] delete failed:", {
      id,
      organizationId,
      code: error.code,
      message: error.message
    });
    return res.status(500).json({ message: "Failed to dismiss pending import." });
  }

  return res.json({ success: true });
});

export { agentPendingImportsRouter };
