import { Router } from "express";
import { supabase } from "../config/supabase";
import { canonicalizeSizeName } from "./pdfImport";
import { type CsvSizeEntry } from "../utils/flowMasterCsvParser";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

const agentPendingImportsRouter = Router();

const canView = requireAnyPermission(["yield:view", "yield:edit"]);
const canEdit = requirePermission("yield:edit");

type PendingImportRow = {
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
};

type ActiveVariety = { id: string; name: string };
type ActiveYieldSize = { name: string };
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
    .select(
      "id, lot_number, variety_name, source_filename, start_time, iso_year, iso_week, average_fruit_weight_g, size_kg, parsed_total_kg, warnings, unknown_sizes, raw_payload, needs_template, data_source_type"
    )
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

  const rows = (pendingRows ?? []) as PendingImportRow[];

  if (rows.length === 0) {
    return res.json({ success: true, count: 0, files: [] });
  }

  const lotNumbers = rows.map((r) => r.lot_number).filter((n): n is string => n !== null);

  const [varietiesResult, yieldSizesResult, yieldEntriesResult, importRunsResult] =
    await Promise.all([
      supabase
        .from("varieties")
        .select("id, name")
        .eq("organization_id", organizationId)
        .eq("status", "active"),
      supabase
        .from("yield_sizes")
        .select("name")
        .eq("organization_id", organizationId)
        .eq("status", "active"),
      supabase
        .from("yield_entries")
        .select("variety_id, year, week")
        .eq("organization_id", organizationId),
      supabase
        .from("yield_import_runs")
        .select("lot_number")
        .eq("organization_id", organizationId)
        .in("lot_number", lotNumbers)
    ]);

  if (varietiesResult.error) {
    return res.status(500).json({ message: "Failed to load varieties." });
  }
  if (yieldSizesResult.error) {
    return res.status(500).json({ message: "Failed to load yield sizes." });
  }
  if (yieldEntriesResult.error) {
    return res.status(500).json({ message: "Failed to load yield entries." });
  }
  if (importRunsResult.error) {
    return res.status(500).json({ message: "Failed to load import history." });
  }

  const activeVarieties = (varietiesResult.data ?? []) as ActiveVariety[];
  const activeYieldSizes = (yieldSizesResult.data ?? []) as ActiveYieldSize[];
  const existingYieldEntries = (yieldEntriesResult.data ?? []) as ExistingYieldEntry[];
  const existingImportRuns = (importRunsResult.data ?? []) as ExistingImportRun[];

  const activeVarietyByName = new Map<string, ActiveVariety>();
  for (const v of activeVarieties) {
    activeVarietyByName.set(v.name, v);
  }

  const activeYieldSizeNameByCanonical = new Map<string, string>();
  for (const s of activeYieldSizes) {
    activeYieldSizeNameByCanonical.set(canonicalizeSizeName(s.name), s.name);
  }

  const existingEntryKeySet = new Set<string>();
  for (const entry of existingYieldEntries) {
    existingEntryKeySet.add(`${entry.variety_id}::${entry.year}::${entry.week}`);
  }

  const alreadyImportedLots = new Set<string>();
  for (const run of existingImportRuns) {
    alreadyImportedLots.add(run.lot_number);
  }

  const files: PdfPreviewSuccess[] = rows.map((row) => {
    const warnings: string[] = Array.isArray(row.warnings)
      ? (row.warnings as string[]).filter((w) => typeof w === "string")
      : [];

    const alreadyImported = row.lot_number !== null && alreadyImportedLots.has(row.lot_number);
    const skipped = alreadyImported;

    if (alreadyImported) {
      warnings.push(`Lot ${row.lot_number} was already imported and will be skipped.`);
    }

    const matchedVariety =
      row.variety_name !== null ? (activeVarietyByName.get(row.variety_name) ?? null) : null;

    if (row.variety_name && !matchedVariety) {
      warnings.push(
        `Variety not found: ${row.variety_name}. Add or rename variety before importing.`
      );
    }

    // Normalise size_kg from JSONB — values may be strings when deserialised from numeric
    const rawSizeKg = row.size_kg ?? {};
    const sizeBreakdown: Record<string, number> = {};
    for (const [sizeName, rawKg] of Object.entries(rawSizeKg)) {
      const kg = typeof rawKg === "number" ? rawKg : Number(rawKg);
      if (Number.isFinite(kg) && kg >= 0) {
        sizeBreakdown[sizeName] = kg;
      }
    }

    const unknownSizeSet = new Set<string>(
      Array.isArray(row.unknown_sizes)
        ? (row.unknown_sizes as unknown[]).filter((s): s is string => typeof s === "string")
        : []
    );

    const mapped: Array<{ pdfSize: string; growlinkSize: string }> = [];

    for (const sizeName of Object.keys(sizeBreakdown)) {
      const canonical = canonicalizeSizeName(sizeName);
      const activeSizeName = activeYieldSizeNameByCanonical.get(canonical);
      if (activeSizeName) {
        mapped.push({ pdfSize: sizeName, growlinkSize: activeSizeName });
      } else {
        unknownSizeSet.add(sizeName);
        warnings.push(
          `New size found: ${sizeName}. Add this size in GrowLink before importing.`
        );
      }
    }

    const unknownSizes = Array.from(unknownSizeSet);

    const duplicateKey =
      matchedVariety && row.iso_year !== null && row.iso_week !== null
        ? `${matchedVariety.id}::${row.iso_year}::${row.iso_week}`
        : null;

    const hasExistingWeeklyData =
      duplicateKey !== null && existingEntryKeySet.has(duplicateKey);

    if (hasExistingWeeklyData && matchedVariety) {
      warnings.push("Existing weekly data found. Import will add these PDF totals to the week.");
    }

    // Extract csvSizes stored in raw_payload at upload time.
    const rawCsvSizes = row.raw_payload?.csvSizes;
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
      matchedVariety: {
        found: Boolean(matchedVariety),
        varietyId: matchedVariety?.id ?? null,
        varietyName: matchedVariety?.name ?? null
      },
      startTime: row.start_time,
      startDate: row.start_time?.slice(0, 10) ?? null,
      isoWeek: row.iso_week,
      isoYear: row.iso_year,
      totalKg: row.parsed_total_kg,
      averageFruitWeightG: row.average_fruit_weight_g,
      sizeBreakdown,
      sizeMappingStatus: {
        mappedCount: mapped.length,
        unmappedCount: unknownSizes.length,
        mapped,
        unmapped: unknownSizes
      },
      duplicateStatus: { found: hasExistingWeeklyData },
      unknownSizes,
      warnings: Array.from(new Set(warnings)),
      csvSizes,
      needsTemplate: row.needs_template,
      dataSourceType: row.data_source_type,
      csvHeaders,
    };
  });

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
