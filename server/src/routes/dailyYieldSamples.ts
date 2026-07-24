import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission } from "../middleware/requirePermission";
import { resolveActor } from "./foodSafety/services/actorIdentity";

const dailyYieldSamplesRouter = Router();

// Desktop-only, organization-wide review of raw mobile Daily Yield samples.
// Gated by the same desktop yield permission as the other Yield pages —
// deliberately does NOT accept mobile:daily_yield, which only grants mobile
// entry rights and must not by itself unlock this org-wide desktop view.
const canViewSamples = requireAnyPermission(["yield:view", "yield:edit"]);

dailyYieldSamplesRouter.get("/daily-yield-samples", canViewSamples, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("daily_yield_samples")
    .select(
      "id, variety_id, phase_name, row_label, row_number, sample_date, session_year, session_week, percent_full, kg_per_full_bin, kg_per_case, calculated_sample_kg, calculated_kg_per_stem, created_at, created_by"
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    return sendSafeError(
      res,
      500,
      "Failed to load daily yield samples.",
      "Daily yield samples list fetch error:",
      error
    );
  }

  const rows = data ?? [];

  const varietyIds = Array.from(new Set(rows.map((row) => row.variety_id)));
  const { data: varietyRows, error: varietyError } = await supabase
    .from("varieties")
    .select("id, name, color")
    .in("id", varietyIds.length > 0 ? varietyIds : ["00000000-0000-0000-0000-000000000000"]);

  if (varietyError) {
    return sendSafeError(
      res,
      500,
      "Failed to load varieties.",
      "Varieties fetch error (daily yield samples):",
      varietyError
    );
  }

  const varietyById = new Map((varietyRows ?? []).map((variety) => [variety.id, variety]));

  const creatorIds = Array.from(
    new Set(rows.map((row) => row.created_by).filter((id): id is string => !!id))
  );
  const identityByUserId = new Map<string, { name: string; initials: string }>();
  await Promise.all(
    creatorIds.map(async (userId) => {
      try {
        const actor = await resolveActor(userId);
        identityByUserId.set(userId, { name: actor.name, initials: actor.initials });
      } catch {
        // Leave unresolved — surfaced as null below rather than failing the whole list.
      }
    })
  );

  const result = rows.map((row) => {
    const variety = varietyById.get(row.variety_id);
    const identity = row.created_by ? identityByUserId.get(row.created_by) : undefined;

    return {
      id: row.id,
      varietyId: row.variety_id,
      varietyName: variety?.name ?? "Unknown variety",
      varietyColor: variety?.color ?? null,
      phaseName: row.phase_name,
      rowLabel: row.row_label,
      rowNumber: row.row_number,
      sampleDate: row.sample_date,
      sessionYear: row.session_year,
      sessionWeek: row.session_week,
      binFillPercent: row.percent_full,
      kgPerFullBin: row.kg_per_full_bin,
      kgPerCase: row.kg_per_case,
      calculatedSampleKg: row.calculated_sample_kg,
      calculatedKgPerStem: row.calculated_kg_per_stem,
      createdAt: row.created_at,
      enteredByName: identity?.name ?? null,
      enteredByInitials: identity?.initials ?? null
    };
  });

  return res.json(result);
});

export { dailyYieldSamplesRouter };
