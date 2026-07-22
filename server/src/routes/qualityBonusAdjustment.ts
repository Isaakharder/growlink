import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import { LINEAR_ADJUSTMENT_DEFAULTS, isCheckType, isWorkloadLevel, round4, VALID_WORKLOAD_LEVELS, type CheckType } from "../utils/bonusCalc";

const router = Router();

const canView = requireAnyPermission(["quality:bonuses_view", "quality:bonuses_edit"]);
const canEdit = requirePermission("quality:bonuses_edit");

const AXES = ["crop_load", "sets_per_plant"] as const;
type Axis = (typeof AXES)[number];
function isAxis(value: unknown): value is Axis {
  return typeof value === "string" && (AXES as readonly string[]).includes(value);
}

// ── Adjustment settings (mode + reference value) ─────────────────────────────

router.get("/quality/bonus-adjustment-settings", canView, async (req, res) => {
  const orgId = req.organizationId;
  if (!isCheckType(req.query.check_type)) return res.status(400).json({ message: "check_type is required" });

  const { data, error } = await supabase
    .from("quality_bonus_adjustment_settings")
    .select("*")
    .eq("organization_id", orgId)
    .eq("check_type", req.query.check_type)
    .maybeSingle();
  if (error) return sendSafeError(res, 500, "Failed to load adjustment settings.", "bonus adjustment settings select:", error);

  if (data) return res.json(data);

  // No row saved yet — report the job's linear defaults so the setup form
  // starts pre-filled with sensible values instead of blank inputs.
  const defaults = LINEAR_ADJUSTMENT_DEFAULTS[req.query.check_type as CheckType];
  return res.json({
    check_type: req.query.check_type,
    threshold_mode: "fixed",
    standard_value: defaults.standardValue,
    value_step: defaults.valueStep,
    speed_change_per_step: defaults.speedChangePerStep,
    min_adjustment: defaults.minAdjustment,
    max_adjustment: defaults.maxAdjustment
  });
});

router.put("/quality/bonus-adjustment-settings", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const body = req.body as Record<string, unknown>;

  if (!isCheckType(body.check_type)) return res.status(400).json({ message: "check_type is required" });
  const checkType = body.check_type;
  const threshold_mode = body.threshold_mode === "auto" ? "auto" : "fixed";
  const defaults = LINEAR_ADJUSTMENT_DEFAULTS[checkType];

  const standard_value = Number(body.standard_value ?? defaults.standardValue);
  const value_step = Number(body.value_step ?? defaults.valueStep);
  const speed_change_per_step = Number(body.speed_change_per_step ?? defaults.speedChangePerStep);
  const min_adjustment = Number(body.min_adjustment ?? defaults.minAdjustment);
  const max_adjustment = Number(body.max_adjustment ?? defaults.maxAdjustment);

  if (!Number.isFinite(standard_value) || standard_value <= 0) {
    return res.status(400).json({ message: "Standard value must be greater than 0" });
  }
  if (!Number.isFinite(value_step) || value_step <= 0) {
    return res.status(400).json({ message: "Step must be greater than 0" });
  }
  if (!Number.isInteger(speed_change_per_step) || speed_change_per_step <= 0) {
    return res.status(400).json({ message: "Speed change per step must be a whole number greater than 0" });
  }
  if (!Number.isInteger(min_adjustment) || min_adjustment > 0) {
    return res.status(400).json({ message: "Minimum adjustment must be a whole number less than or equal to 0" });
  }
  if (!Number.isInteger(max_adjustment) || max_adjustment < 0) {
    return res.status(400).json({ message: "Maximum adjustment must be a whole number greater than or equal to 0" });
  }

  const updates: Record<string, unknown> = {
    threshold_mode,
    standard_value,
    value_step,
    speed_change_per_step,
    min_adjustment,
    max_adjustment
  };

  const { data: existing, error: existingError } = await supabase
    .from("quality_bonus_adjustment_settings")
    .select("id")
    .eq("organization_id", orgId)
    .eq("check_type", body.check_type)
    .maybeSingle();
  if (existingError) return sendSafeError(res, 500, "Failed to load adjustment settings.", "bonus adjustment settings lookup:", existingError);

  if (existing) {
    const { data, error } = await supabase
      .from("quality_bonus_adjustment_settings")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("organization_id", orgId)
      .select()
      .single();
    if (error) return sendSafeError(res, 500, "Failed to update adjustment settings.", "bonus adjustment settings update:", error);
    return res.json(data);
  }

  const { data, error } = await supabase
    .from("quality_bonus_adjustment_settings")
    .insert({ organization_id: orgId, check_type: body.check_type, ...updates })
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to save adjustment settings.", "bonus adjustment settings insert:", error);
  return res.status(201).json(data);
});

// ── Multiplier points (interpolated curve) ───────────────────────────────────

router.get("/quality/bonus-multiplier-points", canView, async (req, res) => {
  const orgId = req.organizationId;
  if (!isCheckType(req.query.check_type)) return res.status(400).json({ message: "check_type is required" });
  if (!isAxis(req.query.axis)) return res.status(400).json({ message: "axis is required" });

  const { data, error } = await supabase
    .from("quality_bonus_multiplier_points")
    .select("*")
    .eq("organization_id", orgId)
    .eq("check_type", req.query.check_type)
    .eq("axis", req.query.axis)
    .order("reference_value");
  if (error) return sendSafeError(res, 500, "Failed to load multiplier points.", "bonus multiplier points select:", error);
  return res.json(data);
});

router.post("/quality/bonus-multiplier-points", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const body = req.body as Record<string, unknown>;

  if (!isCheckType(body.check_type)) return res.status(400).json({ message: "check_type is required" });
  if (!isAxis(body.axis)) return res.status(400).json({ message: "axis is required" });
  const reference_value = Number(body.reference_value);
  const multiplier = Number(body.multiplier);
  if (!Number.isFinite(reference_value) || reference_value < 0) {
    return res.status(400).json({ message: "reference_value cannot be negative" });
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return res.status(400).json({ message: "multiplier must be greater than 0" });
  }

  const { data: existing, error: existingError } = await supabase
    .from("quality_bonus_multiplier_points")
    .select("id")
    .eq("organization_id", orgId)
    .eq("check_type", body.check_type)
    .eq("axis", body.axis)
    .eq("reference_value", reference_value)
    .maybeSingle();
  if (existingError) return sendSafeError(res, 500, "Failed to validate multiplier point.", "bonus multiplier point dup lookup:", existingError);
  if (existing) return res.status(400).json({ message: "A point with this reference value already exists." });

  const { data, error } = await supabase
    .from("quality_bonus_multiplier_points")
    .insert({
      organization_id: orgId,
      check_type: body.check_type,
      axis: body.axis,
      reference_value,
      multiplier: round4(multiplier)
    })
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to create multiplier point.", "bonus multiplier point insert:", error);
  return res.status(201).json(data);
});

router.patch("/quality/bonus-multiplier-points/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const { data: point, error: pointError } = await supabase
    .from("quality_bonus_multiplier_points")
    .select("*")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (pointError) return sendSafeError(res, 500, "Failed to look up multiplier point.", "bonus multiplier point lookup:", pointError);
  if (!point) return res.status(404).json({ message: "Multiplier point not found" });

  const updates: Record<string, unknown> = {};

  if (body.reference_value !== undefined) {
    const reference_value = Number(body.reference_value);
    if (!Number.isFinite(reference_value) || reference_value < 0) {
      return res.status(400).json({ message: "reference_value cannot be negative" });
    }
    if (reference_value !== point.reference_value) {
      const { data: dup, error: dupError } = await supabase
        .from("quality_bonus_multiplier_points")
        .select("id")
        .eq("organization_id", orgId)
        .eq("check_type", point.check_type)
        .eq("axis", point.axis)
        .eq("reference_value", reference_value)
        .neq("id", id)
        .maybeSingle();
      if (dupError) return sendSafeError(res, 500, "Failed to validate multiplier point.", "bonus multiplier point dup lookup (patch):", dupError);
      if (dup) return res.status(400).json({ message: "A point with this reference value already exists." });
    }
    updates.reference_value = reference_value;
  }

  if (body.multiplier !== undefined) {
    const multiplier = Number(body.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      return res.status(400).json({ message: "multiplier must be greater than 0" });
    }
    updates.multiplier = round4(multiplier);
  }

  if (Object.keys(updates).length === 0) return res.status(400).json({ message: "Nothing to update" });

  const { data, error } = await supabase
    .from("quality_bonus_multiplier_points")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", orgId)
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to update multiplier point.", "bonus multiplier point update:", error);
  return res.json(data);
});

router.delete("/quality/bonus-multiplier-points/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;
  const { error } = await supabase
    .from("quality_bonus_multiplier_points")
    .delete()
    .eq("id", id)
    .eq("organization_id", orgId);
  if (error) return sendSafeError(res, 500, "Failed to delete multiplier point.", "bonus multiplier point delete:", error);
  return res.json({ deleted: true });
});

// ── Pruning workload level multipliers (winding_pruning only, fixed 3 rows) ──

router.get("/quality/bonus-workload-levels", canView, async (req, res) => {
  const orgId = req.organizationId;
  if (!isCheckType(req.query.check_type)) return res.status(400).json({ message: "check_type is required" });

  const { data, error } = await supabase
    .from("quality_bonus_workload_levels")
    .select("*")
    .eq("organization_id", orgId)
    .eq("check_type", req.query.check_type);
  if (error) return sendSafeError(res, 500, "Failed to load workload levels.", "bonus workload levels select:", error);

  const byLevel = new Map((data ?? []).map((row) => [row.workload_level, row]));
  const result = VALID_WORKLOAD_LEVELS.map(
    (level) => byLevel.get(level) ?? { check_type: req.query.check_type, workload_level: level, multiplier: 1 }
  );
  return res.json(result);
});

router.put("/quality/bonus-workload-levels", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const body = req.body as Record<string, unknown>;

  if (!isCheckType(body.check_type)) return res.status(400).json({ message: "check_type is required" });
  if (!Array.isArray(body.levels)) return res.status(400).json({ message: "levels array is required" });

  const parsed: { workload_level: string; multiplier: number }[] = [];
  for (const item of body.levels) {
    if (!item || typeof item !== "object") return res.status(400).json({ message: "Invalid levels payload" });
    const r = item as Record<string, unknown>;
    if (!isWorkloadLevel(r.workload_level)) return res.status(400).json({ message: "Invalid workload_level" });
    const multiplier = Number(r.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      return res.status(400).json({ message: `multiplier for ${r.workload_level} must be greater than 0` });
    }
    parsed.push({ workload_level: r.workload_level, multiplier: round4(multiplier) });
  }

  const results = [];
  for (const level of parsed) {
    const { data: existing, error: existingError } = await supabase
      .from("quality_bonus_workload_levels")
      .select("id")
      .eq("organization_id", orgId)
      .eq("check_type", body.check_type)
      .eq("workload_level", level.workload_level)
      .maybeSingle();
    if (existingError) return sendSafeError(res, 500, "Failed to save workload levels.", "bonus workload level lookup:", existingError);

    if (existing) {
      const { data, error } = await supabase
        .from("quality_bonus_workload_levels")
        .update({ multiplier: level.multiplier, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) return sendSafeError(res, 500, "Failed to save workload levels.", "bonus workload level update:", error);
      results.push(data);
    } else {
      const { data, error } = await supabase
        .from("quality_bonus_workload_levels")
        .insert({
          organization_id: orgId,
          check_type: body.check_type,
          workload_level: level.workload_level,
          multiplier: level.multiplier
        })
        .select()
        .single();
      if (error) return sendSafeError(res, 500, "Failed to save workload levels.", "bonus workload level insert:", error);
      results.push(data);
    }
  }

  return res.json(results);
});

export { router as qualityBonusAdjustmentRouter };
