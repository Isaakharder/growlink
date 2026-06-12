import { Router, Request, Response } from "express";
import { supabase } from "../config/supabase";
import { docklinkSupabase, isDocklinkConfigured } from "../config/docklink";
import { requirePermission } from "../middleware/requirePermission";

const integrationsRouter = Router();

interface DocklinkWeeklyColorTotal {
  color: string;
  year: number;
  week: number;
  totalCases: number;
}

interface DocklinkFetchResult {
  weeklyTotals: DocklinkWeeklyColorTotal[];
  fetchedRows: number;
  matchedRows: number;
  skippedRows: number;
}

interface DocklinkSyncResult {
  fetchedRows: number;
  matchedRows: number;
  imported: number;
  updated: number;
  skippedRows: number;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * DockLink schema:
 * - growlink_weekly_color_totals view fields used by GrowLink:
 *   - organization_id
 *   - iso_year
 *   - iso_week
 *   - pack_color
 *   - total_cases
 */

function normalizeColor(color: string): string {
  const normalized = color.toLowerCase().trim();
  const validColors = ["red", "orange", "yellow", "green"];
  
  if (validColors.includes(normalized)) {
    return normalized;
  }
  
  // Try to extract color from patterns like "Yellow Tomato", "RED PEPPER", etc.
  for (const validColor of validColors) {
    if (normalized.includes(validColor)) {
      return validColor;
    }
  }
  
  return "";
}

function getDocklinkConfigError(): string | null {
  const missingVars: string[] = [];

  if (!process.env.DOCKLINK_SUPABASE_URL) {
    missingVars.push("DOCKLINK_SUPABASE_URL");
  }

  if (!process.env.DOCKLINK_SUPABASE_SERVICE_ROLE_KEY) {
    missingVars.push("DOCKLINK_SUPABASE_SERVICE_ROLE_KEY");
  }

  if (missingVars.length > 0) {
    return `DockLink integration is not configured. Missing environment variable(s): ${missingVars.join(", ")}`;
  }

  return null;
}

function getNumericField(row: Record<string, unknown>, fieldName: string): number | null {
  const rawValue = row[fieldName];
  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function isMissingColumnError(errorMessage: string, columnName: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes(`column`) && lower.includes(columnName.toLowerCase()) && lower.includes("does not exist");
}

async function assertGrowlinkOrgScopingReady(): Promise<void> {
  const [colorCaseCheck, varietiesCheck] = await Promise.all([
    supabase.from("color_case_entries").select("organization_id").limit(1),
    supabase.from("varieties").select("organization_id").limit(1)
  ]);

  const colorCaseError = colorCaseCheck.error;
  const varietiesError = varietiesCheck.error;

  const missingOrgColumns =
    (colorCaseError && isMissingColumnError(colorCaseError.message, "organization_id")) ||
    (varietiesError && isMissingColumnError(varietiesError.message, "organization_id"));

  if (missingOrgColumns) {
    throw new HttpError(
      409,
      "GrowLink data tables are not organization-scoped yet. Full org scoping must be done before production use."
    );
  }

  if (colorCaseError) {
    console.error("GrowLink org scoping check - color_case_entries error:", colorCaseError);
    throw new Error("Failed to validate GrowLink data access.");
  }

  if (varietiesError) {
    console.error("GrowLink org scoping check - varieties error:", varietiesError);
    throw new Error("Failed to validate GrowLink data access.");
  }
}

async function getDocklinkOrganizationMapping(organizationId: string): Promise<string> {
  const { data, error } = await supabase
    .from("organization_integrations")
    .select("external_organization_id")
    .eq("organization_id", organizationId)
    .eq("integration_name", "docklink")
    .eq("enabled", true)
    .maybeSingle();

  if (error) {
    const lowerMessage = error.message.toLowerCase();
    if (lowerMessage.includes("does not exist") || lowerMessage.includes("not found")) {
      throw new HttpError(
        503,
        "Organization integration mappings are unavailable. Run latest GrowLink migrations before syncing DockLink."
      );
    }

    console.error("DockLink org mapping fetch error:", error);
    throw new Error("Failed to load DockLink integration configuration.");
  }

  if (!data) {
    console.warn("DockLink sync skipped: no integration mapping for organization");
    throw new HttpError(200, "DockLink sync skipped: integration mapping is not configured.");
  }

  const externalOrganizationId = data.external_organization_id;

  if (typeof externalOrganizationId !== "string" || externalOrganizationId.trim().length === 0) {
    console.warn("DockLink sync skipped: external organization UUID is empty");
    throw new HttpError(200, "DockLink sync skipped: external organization UUID is empty.");
  }

  return externalOrganizationId.trim();
}

async function fetchDocklinkWeeklyTotals(externalOrganizationId: string): Promise<DocklinkFetchResult> {
  const configError = getDocklinkConfigError();
  if (configError) {
    throw new Error(configError);
  }

  if (!docklinkSupabase) {
    throw new Error("DockLink integration is not configured. Supabase client is unavailable.");
  }

  const weeklyTotals: DocklinkWeeklyColorTotal[] = [];
  let skippedRows = 0;

  // Filter at the database level — never fetch another org's rows.
  const { data: viewRows, error: queryError } = await docklinkSupabase
    .from("growlink_weekly_color_totals")
    .select("organization_id, iso_year, iso_week, pack_color, total_cases")
    .eq("organization_id", externalOrganizationId);

  if (queryError) {
    const lowerMessage = queryError.message.toLowerCase();
    if (lowerMessage.includes("does not exist") || lowerMessage.includes("not found")) {
      throw new Error(
        "DockLink view growlink_weekly_color_totals is missing or inaccessible. Ensure finalized export view exists and service role has access."
      );
    }

    console.error("DockLink weekly totals query error:", queryError);
    throw new Error("Failed to query DockLink data.");
  }

  const totalRowsReturned = viewRows?.length ?? 0;
  console.log(`DockLink growlink_weekly_color_totals rows returned for org ${externalOrganizationId}: ${totalRowsReturned}`);

  // Safety re-check: discard any row whose organization_id doesn't match,
  // in case the view's RLS or the eq() filter ever behaves unexpectedly.
  const filteredRows = (viewRows ?? []).filter(row =>
      String(row.organization_id).trim().toLowerCase() ===
      String(externalOrganizationId).trim().toLowerCase()
  );

  const rowsAfterFilter = filteredRows.length;
  if (rowsAfterFilter !== totalRowsReturned) {
    console.warn(
      `DockLink safety filter removed ${totalRowsReturned - rowsAfterFilter} rows that did not match org ${externalOrganizationId}`
    );
  }
  console.log(`DockLink rows after safety filter: ${rowsAfterFilter}`);

  if (!filteredRows || filteredRows.length === 0) {
    return {
      weeklyTotals,
      fetchedRows: totalRowsReturned,
      matchedRows: rowsAfterFilter,
      skippedRows
    };
  }

  for (const row of filteredRows as Record<string, unknown>[]) {
    const colorRaw = row.pack_color;
    if (typeof colorRaw !== "string" || colorRaw.trim().length === 0) {
      skippedRows++;
      continue;
    }

    const normalizedColor = normalizeColor(colorRaw);
    if (!normalizedColor) {
      continue;
    }

    const totalCases = getNumericField(row, "total_cases");
    if (totalCases === null || totalCases < 0) {
      skippedRows++;
      continue;
    }

    const year = getNumericField(row, "iso_year");
    const week = getNumericField(row, "iso_week");

    if (year === null || week === null) {
      skippedRows++;
      continue;
    }

    weeklyTotals.push({
      color: normalizedColor,
      year: Math.trunc(year),
      week: Math.trunc(week),
      totalCases
    });
  }

  if (weeklyTotals.length === 0) {
    throw new Error(
      "DockLink view growlink_weekly_color_totals returned rows but none matched required fields: pack_color, total_cases, iso_year, iso_week."
    );
  }

  console.log(`Processed ${weeklyTotals.length} valid growlink_weekly_color_totals rows after filtering`);
  return {
    weeklyTotals,
    fetchedRows: totalRowsReturned,
    matchedRows: rowsAfterFilter,
    skippedRows
  };
}

async function syncDocklinkCases(req: Request): Promise<DocklinkSyncResult> {
  const configError = getDocklinkConfigError();
  if (configError) {
    throw new Error(configError);
  }

  if (!isDocklinkConfigured()) {
    throw new Error("DockLink integration is not configured. Supabase client is unavailable.");
  }

  const organizationId = req.organizationId;
  await assertGrowlinkOrgScopingReady();
  const externalOrganizationId = await getDocklinkOrganizationMapping(organizationId);

  const { weeklyTotals: docklinkWeeklyTotals, fetchedRows, matchedRows, skippedRows } =
    await fetchDocklinkWeeklyTotals(externalOrganizationId);

  // Group by (color, year, week) in case the view returns duplicates
  type WeekKey = string; // "yellow-2026-20"
  const grouped = new Map<WeekKey, { color: string; year: number; week: number; totalCases: number }>();

  for (const row of docklinkWeeklyTotals) {
    const key = `${row.color}-${row.year}-${row.week}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        color: row.color,
        year: row.year,
        week: row.week,
        totalCases: 0
      });
    }

    const entry = grouped.get(key)!;
    entry.totalCases += row.totalCases;
  }

  // Fetch GrowLink variety areas by color for kg_per_m2 calculation
  const { data: varieties, error: varietiesError } = await supabase
    .from("varieties")
    .select("color, area_m2")
    .eq("organization_id", organizationId)
    .eq("status", "active");

  if (varietiesError) {
    console.error("DockLink sync - variety areas fetch error:", varietiesError);
    throw new Error("Failed to fetch variety data.");
  }

  const colorAreaMap: Record<string, number> = {};
  for (const v of varieties ?? []) {
    const color = (v.color ?? "").toLowerCase();
    if (color) {
      colorAreaMap[color] = (colorAreaMap[color] ?? 0) + (v.area_m2 ?? 0);
    }
  }

  // Upsert into GrowLink color_case_entries
  let imported = 0;
  let updated = 0;

  // TODO: make DEFAULT_CASE_WEIGHT_KG configurable per organization
  const DEFAULT_CASE_WEIGHT_KG = 5.15;

  // Fetch the best known case_weight_kg per color from manually-entered rows.
  // Used as a fallback when the synced week has no manual entry with a positive weight.
  const { data: manualWeightRows } = await supabase
    .from("color_case_entries")
    .select("color, case_weight_kg")
    .eq("organization_id", organizationId)
    .neq("source", "docklink")
    .gt("case_weight_kg", 0)
    .order("year", { ascending: false })
    .order("week", { ascending: false });

  const manualWeightByColor = new Map<string, number>();
  for (const row of manualWeightRows ?? []) {
    const c = (row.color ?? "").toLowerCase();
    if (c && !manualWeightByColor.has(c)) {
      manualWeightByColor.set(c, row.case_weight_kg as number);
    }
  }

  for (const [key, data] of grouped) {
    const color_area_m2 = colorAreaMap[data.color] ?? 0;

    // Look up the existing row for this (color, year, week) to get its id and any
    // manually-set case weight (source may be docklink from a prior sync).
    const { data: existing } = await supabase
      .from("color_case_entries")
      .select("case_weight_kg, id, source")
      .eq("organization_id", organizationId)
      .eq("color", data.color)
      .eq("year", data.year)
      .eq("week", data.week)
      .maybeSingle();

    // Priority: positive weight on existing same-week row → best known manual weight
    // for this color → org-level default constant.
    const existingWeight =
      typeof existing?.case_weight_kg === "number" && existing.case_weight_kg > 0
        ? existing.case_weight_kg
        : null;
    const case_weight_kg =
      existingWeight ?? manualWeightByColor.get(data.color) ?? DEFAULT_CASE_WEIGHT_KG;

    const total_kg = data.totalCases * case_weight_kg;
    const kg_per_m2 = color_area_m2 > 0 ? total_kg / color_area_m2 : 0;

    // Upsert the entry
    const { error: upsertError } = await supabase
      .from("color_case_entries")
      .upsert(
        {
          organization_id: organizationId,
          color: data.color,
          year: data.year,
          week: data.week,
          total_cases: data.totalCases,
          case_weight_kg,
          total_kg,
          kg_per_m2,
          color_area_m2,
          source: "docklink",
          synced_at: new Date().toISOString(),
          source_summary: {
            docklink_view: "growlink_weekly_color_totals",
            docklink_organization_id: externalOrganizationId
          }
        },
        { onConflict: "organization_id,color,year,week" }
      );

    if (upsertError) {
      console.error("DockLink sync - color case upsert error:", upsertError);
      throw new Error("Failed to sync color case data.");
    }

    if (existing?.id) {
      updated++;
    } else {
      imported++;
    }
  }

  return {
    fetchedRows,
    matchedRows,
    imported,
    updated,
    skippedRows
  };
}

integrationsRouter.post("/integrations/docklink/sync-color-cases", requirePermission("cases:edit"), async (req: Request, res: Response) => {
  try {
    const configError = getDocklinkConfigError();
    if (configError) {
      return res.status(503).json({
        message: configError
      });
    }

    if (!isDocklinkConfigured()) {
      return res.status(503).json({
        message: "DockLink integration is not configured. Supabase client is unavailable."
      });
    }

    console.log("DockLink sync started");
    const result = await syncDocklinkCases(req);
    console.log(
      `DockLink sync completed: fetched=${result.fetchedRows}, matched=${result.matchedRows}, imported=${result.imported}, updated=${result.updated}, skipped=${result.skippedRows}`
    );

    return res.json({
      success: true,
      message:
        `Synced DockLink cases: fetched=${result.fetchedRows}, matched=${result.matchedRows}, ` +
        `imported=${result.imported}, updated=${result.updated}, skipped=${result.skippedRows}`,
      ...result
    });
  } catch (error) {
    console.error("DockLink sync error:", error);
    if (error instanceof HttpError) {
      if (error.status === 200) {
        return res.json({
          success: true,
          message: error.message,
          fetchedRows: 0,
          matchedRows: 0,
          imported: 0,
          updated: 0,
          skippedRows: 0
        });
      }

      return res.status(error.status).json({ message: error.message });
    }

    const message = error instanceof Error ? error.message : "Failed to sync DockLink cases";
    return res.status(400).json({ message });
  }
});

// --- Waste sync ---

interface DocklinkWeeklyWasteRow {
  externalVarietyId: string;
  varietyNameSnapshot: string;
  year: number;
  week: number;
  wasteKg: number;
}

interface DocklinkWasteFetchResult {
  wasteRows: DocklinkWeeklyWasteRow[];
  fetchedRows: number;
  matchedRows: number;
  skippedRows: number;
}

interface DocklinkWasteSyncResult {
  fetchedRows: number;
  matchedRows: number;
  matchedVarieties: number;
  unmatchedVarieties: number;
  imported: number;
  updated: number;
  skippedRows: number;
}

async function assertWasteTablesReady(): Promise<void> {
  const [wasteCheck, mappingsCheck] = await Promise.all([
    supabase.from("waste_imports").select("organization_id").limit(1),
    supabase.from("waste_variety_mappings").select("organization_id").limit(1)
  ]);

  for (const [label, check] of [["waste_imports", wasteCheck], ["waste_variety_mappings", mappingsCheck]] as const) {
    if (check.error) {
      const lower = check.error.message.toLowerCase();
      if (lower.includes("does not exist") || lower.includes("not found")) {
        throw new HttpError(503, `${label} table is not available. Run latest GrowLink migrations before syncing waste data.`);
      }
      console.error(`Waste tables readiness check error (${label}):`, check.error);
      throw new Error("Failed to validate waste tables.");
    }
  }
}

async function fetchDocklinkWeeklyWaste(externalOrganizationId: string): Promise<DocklinkWasteFetchResult> {
  if (!docklinkSupabase) {
    throw new Error("DockLink integration is not configured. Supabase client is unavailable.");
  }

  const wasteRows: DocklinkWeeklyWasteRow[] = [];
  let skippedRows = 0;

  const { data: viewRows, error: queryError } = await docklinkSupabase
    .from("growlink_weekly_waste_totals")
    .select("organization_id, year, week, external_variety_id, variety_name, waste_kg")
    .eq("organization_id", externalOrganizationId);

  if (queryError) {
    const lower = queryError.message.toLowerCase();
    if (lower.includes("does not exist") || lower.includes("not found")) {
      throw new Error(
        "DockLink view growlink_weekly_waste_totals is missing or inaccessible. Ensure the export view exists and service role has access."
      );
    }
    console.error("DockLink weekly waste query error:", queryError);
    throw new Error("Failed to query DockLink waste data.");
  }

  const totalRowsReturned = viewRows?.length ?? 0;
  console.log(`DockLink growlink_weekly_waste_totals rows returned for org ${externalOrganizationId}: ${totalRowsReturned}`);

  // Safety re-filter: discard any row whose organization_id doesn't match,
  // in case the view's filter ever behaves unexpectedly.
  const filteredRows = (viewRows ?? []).filter(row =>
    String(row.organization_id).trim().toLowerCase() ===
    String(externalOrganizationId).trim().toLowerCase()
  );

  const rowsAfterFilter = filteredRows.length;
  if (rowsAfterFilter !== totalRowsReturned) {
    console.warn(
      `DockLink waste safety filter removed ${totalRowsReturned - rowsAfterFilter} rows that did not match org ${externalOrganizationId}`
    );
  }
  console.log(`DockLink waste rows after safety filter: ${rowsAfterFilter}`);

  if (filteredRows.length === 0) {
    return { wasteRows, fetchedRows: totalRowsReturned, matchedRows: rowsAfterFilter, skippedRows };
  }

  for (const row of filteredRows as Record<string, unknown>[]) {
    const externalVarietyId = row.external_variety_id;
    if (typeof externalVarietyId !== "string" || externalVarietyId.trim().length === 0) {
      skippedRows++;
      continue;
    }

    const varietyName = row.variety_name;
    if (typeof varietyName !== "string" || varietyName.trim().length === 0) {
      skippedRows++;
      continue;
    }

    const wasteKg = getNumericField(row, "waste_kg");
    if (wasteKg === null || wasteKg < 0) {
      skippedRows++;
      continue;
    }

    const year = getNumericField(row, "year");
    const week = getNumericField(row, "week");
    if (year === null || week === null) {
      skippedRows++;
      continue;
    }

    wasteRows.push({
      externalVarietyId: externalVarietyId.trim(),
      varietyNameSnapshot: varietyName.trim(),
      year: Math.trunc(year),
      week: Math.trunc(week),
      wasteKg
    });
  }

  console.log(`Processed ${wasteRows.length} valid growlink_weekly_waste_totals rows after filtering`);
  return { wasteRows, fetchedRows: totalRowsReturned, matchedRows: rowsAfterFilter, skippedRows };
}

async function syncDocklinkWaste(req: Request): Promise<DocklinkWasteSyncResult> {
  const configError = getDocklinkConfigError();
  if (configError) throw new Error(configError);

  if (!isDocklinkConfigured()) {
    throw new Error("DockLink integration is not configured. Supabase client is unavailable.");
  }

  const organizationId = req.organizationId;
  await assertWasteTablesReady();
  const externalOrganizationId = await getDocklinkOrganizationMapping(organizationId);

  const { wasteRows, fetchedRows, matchedRows, skippedRows } =
    await fetchDocklinkWeeklyWaste(externalOrganizationId);

  if (wasteRows.length === 0) {
    return { fetchedRows, matchedRows, matchedVarieties: 0, unmatchedVarieties: 0, imported: 0, updated: 0, skippedRows };
  }

  // Pre-fetch variety mappings and GrowLink varieties in parallel to avoid N+1 queries
  const [mappingsResult, varietiesResult] = await Promise.all([
    supabase
      .from("waste_variety_mappings")
      .select("external_variety_id, variety_id")
      .eq("organization_id", organizationId),
    supabase
      .from("varieties")
      .select("id, name, color")
      .eq("organization_id", organizationId)
      .eq("status", "active")
  ]);

  if (mappingsResult.error) {
    console.error("DockLink waste sync - variety mappings fetch error:", mappingsResult.error);
    throw new Error("Failed to fetch waste variety mappings.");
  }
  if (varietiesResult.error) {
    console.error("DockLink waste sync - varieties fetch error:", varietiesResult.error);
    throw new Error("Failed to fetch variety data.");
  }

  const mappingByExternalId = new Map<string, string>();
  for (const m of mappingsResult.data ?? []) {
    if (m.external_variety_id && m.variety_id) {
      mappingByExternalId.set(m.external_variety_id, m.variety_id);
    }
  }

  const varietyColorById = new Map<string, string>();
  const varietyByNormalizedName = new Map<string, { id: string; color: string }>();
  for (const v of varietiesResult.data ?? []) {
    varietyColorById.set(v.id, v.color);
    varietyByNormalizedName.set(v.name.toLowerCase().trim(), { id: v.id, color: v.color });
  }

  let imported = 0;
  let updated = 0;
  let matchedVarieties = 0;
  let unmatchedVarieties = 0;

  for (const row of wasteRows) {
    // Resolve GrowLink variety: explicit mapping first, then case-insensitive name auto-match
    let resolvedVarietyId: string | null = mappingByExternalId.get(row.externalVarietyId) ?? null;
    let resolvedColor: string | null = null;
    let matchSource: string;

    if (resolvedVarietyId) {
      resolvedColor = varietyColorById.get(resolvedVarietyId) ?? null;
      matchSource = "mapping";
      matchedVarieties++;
    } else {
      const nameMatch = varietyByNormalizedName.get(row.varietyNameSnapshot.toLowerCase().trim());
      if (nameMatch) {
        resolvedVarietyId = nameMatch.id;
        resolvedColor = nameMatch.color;
        matchSource = "name_match";
        matchedVarieties++;
      } else {
        matchSource = "unmatched";
        unmatchedVarieties++;
      }
    }

    const { data: existing } = await supabase
      .from("waste_imports")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("external_variety_id", row.externalVarietyId)
      .eq("year", row.year)
      .eq("week", row.week)
      .maybeSingle();

    const { error: upsertError } = await supabase
      .from("waste_imports")
      .upsert(
        {
          organization_id: organizationId,
          variety_id: resolvedVarietyId,
          external_variety_id: row.externalVarietyId,
          variety_name_snapshot: row.varietyNameSnapshot,
          color: resolvedColor,
          year: row.year,
          week: row.week,
          waste_kg: row.wasteKg,
          source: "docklink",
          synced_at: new Date().toISOString(),
          source_summary: {
            docklink_view: "growlink_weekly_waste_totals",
            docklink_organization_id: externalOrganizationId,
            match_source: matchSource
          }
        },
        { onConflict: "organization_id,external_variety_id,year,week" }
      );

    if (upsertError) {
      console.error("DockLink waste sync - upsert error:", upsertError);
      throw new Error("Failed to sync waste data.");
    }

    if (existing?.id) {
      updated++;
    } else {
      imported++;
    }
  }

  return { fetchedRows, matchedRows, matchedVarieties, unmatchedVarieties, imported, updated, skippedRows };
}

integrationsRouter.post("/integrations/docklink/sync-waste", requirePermission("cases:edit"), async (req: Request, res: Response) => {
  try {
    const configError = getDocklinkConfigError();
    if (configError) {
      return res.status(503).json({ message: configError });
    }

    if (!isDocklinkConfigured()) {
      return res.status(503).json({ message: "DockLink integration is not configured. Supabase client is unavailable." });
    }

    console.log("DockLink waste sync started");
    const result = await syncDocklinkWaste(req);
    console.log(
      `DockLink waste sync completed: fetched=${result.fetchedRows}, matched=${result.matchedRows}, ` +
      `matchedVarieties=${result.matchedVarieties}, unmatchedVarieties=${result.unmatchedVarieties}, ` +
      `imported=${result.imported}, updated=${result.updated}, skipped=${result.skippedRows}`
    );

    return res.json({
      success: true,
      message:
        `Synced DockLink waste: fetched=${result.fetchedRows}, matched=${result.matchedRows}, ` +
        `matchedVarieties=${result.matchedVarieties}, unmatchedVarieties=${result.unmatchedVarieties}, ` +
        `imported=${result.imported}, updated=${result.updated}, skipped=${result.skippedRows}`,
      ...result
    });
  } catch (error) {
    console.error("DockLink waste sync error:", error);
    if (error instanceof HttpError) {
      if (error.status === 200) {
        return res.json({
          success: true,
          message: error.message,
          fetchedRows: 0,
          matchedRows: 0,
          matchedVarieties: 0,
          unmatchedVarieties: 0,
          imported: 0,
          updated: 0,
          skippedRows: 0
        });
      }
      return res.status(error.status).json({ message: error.message });
    }

    const message = error instanceof Error ? error.message : "Failed to sync DockLink waste";
    return res.status(400).json({ message });
  }
});

export { integrationsRouter };
