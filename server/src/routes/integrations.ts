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
    throw new Error(`Failed to validate organization scoping for color_case_entries: ${colorCaseError.message}`);
  }

  if (varietiesError) {
    throw new Error(`Failed to validate organization scoping for varieties: ${varietiesError.message}`);
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

    throw new Error(`Failed to load organization DockLink mapping: ${error.message}`);
  }

  const externalOrganizationId = data?.external_organization_id;

  if (typeof externalOrganizationId !== "string" || externalOrganizationId.trim().length === 0) {
    throw new HttpError(403, "DockLink integration is not configured for this organization.");
  }

  return externalOrganizationId.trim();
}

async function fetchDocklinkWeeklyTotals(externalOrganizationId: string): Promise<DocklinkWeeklyColorTotal[]> {
  const configError = getDocklinkConfigError();
  if (configError) {
    throw new Error(configError);
  }

  if (!docklinkSupabase) {
    throw new Error("DockLink integration is not configured. Supabase client is unavailable.");
  }

  const weeklyTotals: DocklinkWeeklyColorTotal[] = [];

  console.log(`DockLink mapped external organization id: ${externalOrganizationId}`);

  const { data: viewRows, error: queryError } = await docklinkSupabase
    .from("growlink_weekly_color_totals")
    .select("organization_id, iso_year, iso_week, pack_color, total_cases")
    .eq("organization_id", externalOrganizationId);

  if (queryError) {
    console.error("DockLink growlink_weekly_color_totals query error:", queryError);
    const lowerMessage = queryError.message.toLowerCase();
    if (lowerMessage.includes("does not exist") || lowerMessage.includes("not found")) {
      throw new Error(
        "DockLink view growlink_weekly_color_totals is missing or inaccessible. Ensure finalized export view exists and service role has access."
      );
    }

    throw new Error(`Failed to query DockLink growlink_weekly_color_totals: ${queryError.message}`);
  }

  const rowCount = viewRows?.length ?? 0;
  console.log(`DockLink growlink_weekly_color_totals returned rows: ${rowCount}`);

  if (!viewRows || viewRows.length === 0) {
    console.log(`No rows found in DockLink growlink_weekly_color_totals for mapped organization ${externalOrganizationId}`);
    return weeklyTotals;
  }

  for (const row of viewRows as Record<string, unknown>[]) {
    const colorRaw = row.pack_color;
    if (typeof colorRaw !== "string" || colorRaw.trim().length === 0) {
      continue;
    }

    const normalizedColor = normalizeColor(colorRaw);
    if (!normalizedColor) {
      console.warn(`Could not normalize color from DockLink view pack_color: "${String(colorRaw)}"`);
      continue;
    }

    const totalCases = getNumericField(row, "total_cases");
    if (totalCases === null || totalCases < 0) {
      continue;
    }

    const year = getNumericField(row, "iso_year");
    const week = getNumericField(row, "iso_week");

    if (year === null || week === null) {
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
  return weeklyTotals;
}

async function syncDocklinkCases(req: Request): Promise<{ imported: number; updated: number }> {
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

  const docklinkWeeklyTotals = await fetchDocklinkWeeklyTotals(externalOrganizationId);

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

  console.log(
    `Grouped into ${grouped.size} weekly color totals:`,
    Array.from(grouped.entries()).map(
      ([key, data]) => `${data.color} week ${data.year}W${data.week}: ${data.totalCases} cases`
    )
  );

  // Fetch GrowLink variety areas by color for kg_per_m2 calculation
  const { data: varieties, error: varietiesError } = await supabase
    .from("varieties")
    .select("color, area_m2")
    .eq("organization_id", organizationId)
    .eq("status", "active");

  if (varietiesError) {
    throw new Error(`Failed to fetch variety areas: ${varietiesError.message}`);
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
      console.error(`Failed to upsert color case entry for ${key}:`, upsertError);
      throw new Error(`Failed to sync color case entry: ${upsertError.message}`);
    }

    if (existing?.id) {
      updated++;
    } else {
      imported++;
    }
  }

  return { imported, updated };
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

    const result = await syncDocklinkCases(req);

    return res.json({
      success: true,
      message: `Synced DockLink cases: ${result.imported} imported, ${result.updated} updated`,
      ...result
    });
  } catch (error) {
    console.error("DockLink sync error:", error);
    if (error instanceof HttpError) {
      return res.status(error.status).json({ message: error.message });
    }

    const message = error instanceof Error ? error.message : "Failed to sync DockLink cases";
    return res.status(400).json({ message });
  }
});

export { integrationsRouter };
