import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission, requirePermission } from "../middleware/requirePermission";

const yieldProjectionsRouter = Router();
const canView = requireAnyPermission(["yield:view", "yield:edit"]);
const canEdit = requirePermission("yield:edit");

const VALID_COLORS = new Set(["red", "orange", "yellow", "green"]);

function parseYear(raw: unknown, fieldName = "year"): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(n) || n < 2000 || n > 2100) {
    throw new Error(`${fieldName} must be an integer between 2000 and 2100`);
  }
  return n;
}

function parseWeek(raw: unknown, fieldName = "week"): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(n) || n < 1 || n > 53) {
    throw new Error(`${fieldName} must be between 1 and 53`);
  }
  return n;
}

// Convert an ISO year+week to the UTC date of that week's Monday.
// Anchored on Jan 4, which is always in ISO week 1.
function isoWeekToDate(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7; // Monday=1 … Sunday=7
  const week1Mon = Date.UTC(year, 0, 4 - dow + 1);
  return new Date(week1Mon + (week - 1) * 7 * 86400000);
}

// Signed integer: how many ISO weeks is target after forecast?
// Negative means target is in the past relative to forecast.
function computeWeeksOut(
  forecastYear: number, forecastWeek: number,
  targetYear: number, targetWeek: number
): number {
  const diff = isoWeekToDate(targetYear, targetWeek).getTime()
    - isoWeekToDate(forecastYear, forecastWeek).getTime();
  return Math.round(diff / (7 * 86400000));
}

// Raw shape returned by Supabase after migration 0045.
// Typed explicitly because the generated Supabase types still reference the
// old column names (year/week) until the schema types are regenerated.
type ProjectionRow = {
  id: string;
  target_year: number;
  target_week: number;
  forecast_year: number;
  forecast_week: number;
  weeks_out: number;
  projection_level: string;
  variety_id: string | null;
  color: string | null;
  unit: string;
  projected_amount: number;
  notes: string | null;
};

// ── GET /api/yield/projections?year=2026 ─────────────────────────────────────
// Returns all projections for the org + target_year, enriched with actuals.
// The `year` query param is an alias for `target_year`.
// Frontend handles forecast-week filtering and summary grouping client-side.
yieldProjectionsRouter.get("/yield/projections", canView, async (req, res) => {
  const organizationId = req.organizationId;
  let targetYear: number;

  try {
    // Accept both `year` (legacy) and `target_year`
    targetYear = parseYear(req.query.target_year ?? req.query.year, "year");
  } catch (e) {
    return res.status(400).json({ message: e instanceof Error ? e.message : "Invalid year" });
  }

  try {
    // 1. Load projections for this org+target_year
    const { data: projections, error: projErr } = await supabase
      .from("yield_projections")
      .select(
        "id, target_year, target_week, forecast_year, forecast_week, weeks_out, " +
        "projection_level, variety_id, color, unit, projected_amount, notes"
      )
      .eq("organization_id", organizationId)
      .eq("target_year", targetYear)
      .order("target_week", { ascending: true });

    if (projErr) {
      return sendSafeError(res, 500, "Failed to load projections.", "Yield projections fetch:", projErr);
    }

    // 2. Load variety metadata (name + color) for this org
    const { data: varieties } = await supabase
      .from("varieties")
      .select("id, name, color")
      .eq("organization_id", organizationId);

    const varietyById = new Map<string, { name: string; color: string }>();
    for (const v of varieties ?? []) {
      varietyById.set(v.id as string, {
        name: v.name as string,
        color: (v.color as string) ?? "",
      });
    }

    // 3. Load kg actuals from yield_entries for this org+target_year
    const { data: yieldEntries } = await supabase
      .from("yield_entries")
      .select("variety_id, week, total_kg, total_cases")
      .eq("organization_id", organizationId)
      .eq("year", targetYear);

    const actualKgByVarietyWeek = new Map<string, number>();
    const actualCasesByVarietyWeek = new Map<string, number>();
    const actualKgByColorWeek = new Map<string, number>();

    for (const entry of yieldEntries ?? []) {
      const vk = `${entry.variety_id as string}:${entry.week as number}`;
      actualKgByVarietyWeek.set(vk, Number(entry.total_kg ?? 0));
      actualCasesByVarietyWeek.set(vk, Number(entry.total_cases ?? 0));

      const color = varietyById.get(entry.variety_id as string)?.color;
      if (color) {
        const ck = `${color}:${entry.week as number}`;
        actualKgByColorWeek.set(ck, (actualKgByColorWeek.get(ck) ?? 0) + Number(entry.total_kg ?? 0));
      }
    }

    // 4. Load cases actuals from color_case_entries for this org+target_year
    const { data: caseEntries } = await supabase
      .from("color_case_entries")
      .select("color, week, total_cases")
      .eq("organization_id", organizationId)
      .eq("year", targetYear);

    const actualCasesByColorWeek = new Map<string, number>();
    for (const entry of caseEntries ?? []) {
      actualCasesByColorWeek.set(
        `${entry.color as string}:${entry.week as number}`,
        Number(entry.total_cases ?? 0)
      );
    }

    // 5. Enrich each projection with actual + accuracy
    const rows = (projections ?? []) as unknown as ProjectionRow[];
    const enriched = rows.map((p) => {
      const projected = Number(p.projected_amount);
      const targetWeek = p.target_week;
      const varietyInfo = p.variety_id ? varietyById.get(p.variety_id) : null;

      let actual_amount: number | null = null;

      if (p.projection_level === "variety" && p.variety_id) {
        const key = `${p.variety_id}:${targetWeek}`;
        if (p.unit === "kg") {
          if (actualKgByVarietyWeek.has(key)) actual_amount = actualKgByVarietyWeek.get(key)!;
        } else {
          // Cases sourced from yield_entries.total_cases (kg / case_weight at entry time)
          if (actualCasesByVarietyWeek.has(key)) actual_amount = actualCasesByVarietyWeek.get(key)!;
        }
      } else if (p.projection_level === "color" && p.color) {
        const key = `${p.color}:${targetWeek}`;
        if (p.unit === "kg") {
          if (actualKgByColorWeek.has(key)) actual_amount = actualKgByColorWeek.get(key)!;
        } else {
          if (actualCasesByColorWeek.has(key)) actual_amount = actualCasesByColorWeek.get(key)!;
        }
      }

      const difference = actual_amount !== null ? actual_amount - projected : null;
      // Guard: projected=0 → accuracy stays null (no divide-by-zero)
      const accuracy_percent =
        actual_amount !== null && projected > 0
          ? Math.round((actual_amount / projected) * 1000) / 10
          : null;
      const label =
        difference === null ? null
          : difference < 0 ? "short"
          : difference > 0 ? "over"
          : "exact";

      return {
        id: p.id,
        target_year: p.target_year,
        target_week: targetWeek,
        forecast_year: p.forecast_year,
        forecast_week: p.forecast_week,
        weeks_out: p.weeks_out,
        projection_level: p.projection_level,
        variety_id: p.variety_id ?? null,
        variety_name: varietyInfo?.name ?? null,
        variety_color: varietyInfo?.color ?? null,
        color: p.color ?? null,
        unit: p.unit,
        projected_amount: projected,
        actual_amount,
        difference,
        accuracy_percent,
        label,
        notes: p.notes ?? null,
      };
    });

    return res.json(enriched);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load projections";
    return res.status(500).json({ message });
  }
});

// ── POST /api/yield/projections/bulk ─────────────────────────────────────────
// Upsert projections. Rows with `id` are updated; rows without `id` are inserted.
// Each row must include forecast coordinates. weeks_out is computed server-side.
// Rows from different forecast weeks for the same target week do NOT overwrite
// each other — the unique index includes both forecast + target coordinates.
yieldProjectionsRouter.post("/yield/projections/bulk", canEdit, async (req, res) => {
  const organizationId = req.organizationId;

  const rawItems: unknown[] = Array.isArray(req.body?.projections) ? req.body.projections : [];
  if (rawItems.length === 0) {
    return res.status(400).json({ message: "projections array is required and must not be empty" });
  }

  type InsertRow = {
    organization_id: string;
    target_year: number;
    target_week: number;
    forecast_year: number;
    forecast_week: number;
    weeks_out: number;
    projection_level: string;
    variety_id: string | null;
    color: string | null;
    unit: string;
    projected_amount: number;
    notes: string | null;
  };
  type UpdateRow = { id: string; projected_amount: number; notes: string | null };

  const toInsert: InsertRow[] = [];
  const toUpdate: UpdateRow[] = [];
  const varietyIdsToVerify = new Set<string>();

  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;

    let targetYear: number, targetWeek: number, forecastYear: number, forecastWeek: number;
    try {
      targetYear   = parseYear(item.target_year,   "target_year");
      targetWeek   = parseWeek(item.target_week,   "target_week");
      forecastYear = parseYear(item.forecast_year, "forecast_year");
      forecastWeek = parseWeek(item.forecast_week, "forecast_week");
    } catch (e) {
      return res.status(400).json({ message: e instanceof Error ? e.message : "Invalid field" });
    }

    const weeksOut = computeWeeksOut(forecastYear, forecastWeek, targetYear, targetWeek);

    const level = String(item.projection_level ?? "");
    if (level !== "variety" && level !== "color") {
      return res.status(400).json({ message: "projection_level must be 'variety' or 'color'" });
    }

    const unit = String(item.unit ?? "");
    if (unit !== "kg" && unit !== "cases") {
      return res.status(400).json({ message: "unit must be 'kg' or 'cases'" });
    }

    const projected_amount = Number(item.projected_amount);
    if (!Number.isFinite(projected_amount) || projected_amount < 0) {
      return res.status(400).json({ message: "projected_amount must be a number >= 0" });
    }

    const notes = item.notes != null && item.notes !== "" ? String(item.notes) : null;
    const rowId = typeof item.id === "string" && item.id.length > 0 ? item.id : null;

    const base: Omit<InsertRow, "variety_id" | "color"> = {
      organization_id: organizationId,
      target_year: targetYear,
      target_week: targetWeek,
      forecast_year: forecastYear,
      forecast_week: forecastWeek,
      weeks_out: weeksOut,
      projection_level: level,
      unit,
      projected_amount,
      notes,
    };

    if (level === "variety") {
      const variety_id = typeof item.variety_id === "string" ? item.variety_id.trim() : "";
      if (!variety_id) {
        return res.status(400).json({ message: "variety_id is required for variety-level projections" });
      }
      varietyIdsToVerify.add(variety_id);
      if (rowId) {
        toUpdate.push({ id: rowId, projected_amount, notes });
      } else {
        toInsert.push({ ...base, variety_id, color: null });
      }
    } else {
      const color = String(item.color ?? "");
      if (!VALID_COLORS.has(color)) {
        return res.status(400).json({ message: "color must be red, orange, yellow, or green" });
      }
      if (rowId) {
        toUpdate.push({ id: rowId, projected_amount, notes });
      } else {
        toInsert.push({ ...base, variety_id: null, color });
      }
    }
  }

  try {
    // Verify all variety_ids belong to this org before any writes
    if (varietyIdsToVerify.size > 0) {
      const { data: validVarieties, error: vErr } = await supabase
        .from("varieties")
        .select("id")
        .eq("organization_id", organizationId)
        .in("id", [...varietyIdsToVerify]);

      if (vErr) {
        return sendSafeError(res, 500, "Failed to validate varieties.", "Variety validation:", vErr);
      }
      const validIds = new Set((validVarieties ?? []).map((v) => v.id as string));
      for (const id of varietyIdsToVerify) {
        if (!validIds.has(id)) {
          return res.status(403).json({ message: "One or more variety_ids do not belong to your organization" });
        }
      }
    }

    let savedCount = 0;
    const errors: string[] = [];

    // Updates: org-scoped by id so a user cannot update another org's row
    for (const u of toUpdate) {
      const { error } = await supabase
        .from("yield_projections")
        .update({ projected_amount: u.projected_amount, notes: u.notes, updated_at: new Date().toISOString() })
        .eq("id", u.id)
        .eq("organization_id", organizationId);

      if (error) errors.push(`Update ${u.id}: ${error.message}`);
      else savedCount++;
    }

    // Inserts in one batch
    if (toInsert.length > 0) {
      const { data: inserted, error: insErr } = await supabase
        .from("yield_projections")
        .insert(toInsert)
        .select("id");

      if (insErr) errors.push(`Insert: ${insErr.message}`);
      else savedCount += (inserted ?? []).length;
    }

    if (errors.length > 0) {
      return res.status(500).json({ message: errors.join("; ") });
    }

    return res.json({ saved: savedCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save projections";
    return res.status(500).json({ message });
  }
});

// ── DELETE /api/yield/projections/:id ────────────────────────────────────────
// Deletes a single projection row. Org-scoped — cannot delete another org's row.
yieldProjectionsRouter.delete("/yield/projections/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("yield_projections")
      .delete()
      .eq("id", id)
      .eq("organization_id", organizationId);

    if (error) {
      return sendSafeError(res, 500, "Failed to delete projection.", "Yield projection delete:", error);
    }

    return res.status(204).send();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete projection";
    return res.status(500).json({ message });
  }
});

export { yieldProjectionsRouter };
