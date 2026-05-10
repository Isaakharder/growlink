import { Router, Request, Response } from "express";
import { supabase } from "../config/supabase";
import { docklinkSupabase, isDocklinkConfigured } from "../config/docklink";

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

  const { data: viewRows, error: queryError } = await docklinkSupabase
    .from("growlink_weekly_color_totals")
    .select("organization_id, iso_year, iso_week, pack_color, total_cases");

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
  console.log(`DockLink growlink_weekly_color_totals total rows returned: ${totalRowsReturned}`);

  // Server-side org filter (case-insensitive string comparison with trim)
  const filteredRows = (viewRows ?? []).filter(row =>
      String(row.organization_id).trim().toLowerCase() ===
      String(externalOrganizationId).trim().toLowerCase()
  );

  const rowsAfterFilter = filteredRows.length;
  console.log(`DockLink rows after server-side org filter: ${rowsAfterFilter}`);

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

  for (const [key, data] of grouped) {
    const color_area_m2 = colorAreaMap[data.color] ?? 0;

    // Try to find existing case_weight_kg from manual entry
    const { data: existing } = await supabase
      .from("color_case_entries")
      .select("case_weight_kg, id")
      .eq("organization_id", organizationId)
      .eq("color", data.color)
      .eq("year", data.year)
      .eq("week", data.week)
      .maybeSingle();

    const case_weight_kg = existing?.case_weight_kg ?? 0;
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

integrationsRouter.post("/integrations/docklink/sync-color-cases", async (req: Request, res: Response) => {
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

export { integrationsRouter };
