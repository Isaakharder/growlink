import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import { CheckType, computeBonus, isCheckType, round2, speedUnitFor } from "../utils/bonusCalc";

const router = Router();

const canView = requireAnyPermission(["quality:bonuses_view", "quality:bonuses_edit"]);
const canEdit = requirePermission("quality:bonuses_edit");

// ── Bonus tiers (setup) ──────────────────────────────────────────────────────

router.get("/quality/bonus-tiers", canView, async (req, res) => {
  const orgId = req.organizationId;
  let query = supabase
    .from("quality_bonus_tiers")
    .select("*")
    .eq("organization_id", orgId)
    .order("check_type")
    .order("min_speed");

  if (isCheckType(req.query.check_type)) {
    query = query.eq("check_type", req.query.check_type);
  }

  const { data, error } = await query;
  if (error) return sendSafeError(res, 500, "Failed to load bonus tiers.", "quality bonus tiers select:", error);
  return res.json(data);
});

router.post("/quality/bonus-tiers", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const userId = req.userId;
  const body = req.body as Record<string, unknown>;

  if (!isCheckType(body.check_type)) return res.status(400).json({ message: "check_type is required" });
  const min_speed = Number(body.min_speed);
  const bonus_rate_per_hour = Number(body.bonus_rate_per_hour);

  if (!Number.isFinite(min_speed) || min_speed <= 0) {
    return res.status(400).json({ message: "min_speed must be greater than 0" });
  }
  if (!Number.isFinite(bonus_rate_per_hour) || bonus_rate_per_hour < 0) {
    return res.status(400).json({ message: "bonus_rate_per_hour cannot be negative" });
  }

  const { data: existing, error: existingError } = await supabase
    .from("quality_bonus_tiers")
    .select("id")
    .eq("organization_id", orgId)
    .eq("check_type", body.check_type)
    .eq("min_speed", min_speed)
    .maybeSingle();
  if (existingError) return sendSafeError(res, 500, "Failed to validate tier.", "quality bonus tier dup lookup:", existingError);
  if (existing) return res.status(400).json({ message: "A tier with this speed threshold already exists for this job." });

  const { data, error } = await supabase
    .from("quality_bonus_tiers")
    .insert({
      organization_id: orgId,
      check_type: body.check_type,
      min_speed,
      bonus_rate_per_hour: round2(bonus_rate_per_hour),
      created_by: userId
    })
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to create bonus tier.", "quality bonus tier insert:", error);
  return res.status(201).json(data);
});

router.patch("/quality/bonus-tiers/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const { data: tier, error: tierError } = await supabase
    .from("quality_bonus_tiers")
    .select("*")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (tierError) return sendSafeError(res, 500, "Failed to look up bonus tier.", "quality bonus tier lookup:", tierError);
  if (!tier) return res.status(404).json({ message: "Bonus tier not found" });

  const updates: Record<string, unknown> = {};

  if (body.min_speed !== undefined) {
    const min_speed = Number(body.min_speed);
    if (!Number.isFinite(min_speed) || min_speed <= 0) {
      return res.status(400).json({ message: "min_speed must be greater than 0" });
    }
    if (min_speed !== tier.min_speed) {
      const { data: dup, error: dupError } = await supabase
        .from("quality_bonus_tiers")
        .select("id")
        .eq("organization_id", orgId)
        .eq("check_type", tier.check_type)
        .eq("min_speed", min_speed)
        .neq("id", id)
        .maybeSingle();
      if (dupError) return sendSafeError(res, 500, "Failed to validate tier.", "quality bonus tier dup lookup (patch):", dupError);
      if (dup) return res.status(400).json({ message: "A tier with this speed threshold already exists for this job." });
    }
    updates.min_speed = min_speed;
  }

  if (body.bonus_rate_per_hour !== undefined) {
    const bonus_rate_per_hour = Number(body.bonus_rate_per_hour);
    if (!Number.isFinite(bonus_rate_per_hour) || bonus_rate_per_hour < 0) {
      return res.status(400).json({ message: "bonus_rate_per_hour cannot be negative" });
    }
    updates.bonus_rate_per_hour = round2(bonus_rate_per_hour);
  }

  if (Object.keys(updates).length === 0) return res.status(400).json({ message: "Nothing to update" });
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("quality_bonus_tiers")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", orgId)
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to update bonus tier.", "quality bonus tier update:", error);
  return res.json(data);
});

router.delete("/quality/bonus-tiers/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;
  const { error } = await supabase
    .from("quality_bonus_tiers")
    .delete()
    .eq("id", id)
    .eq("organization_id", orgId);
  if (error) return sendSafeError(res, 500, "Failed to delete bonus tier.", "quality bonus tier delete:", error);
  return res.json({ deleted: true });
});

// ── Bonus entries ─────────────────────────────────────────────────────────────

router.get("/quality/bonus-entries", canView, async (req, res) => {
  const orgId = req.organizationId;
  let query = supabase
    .from("quality_bonus_entries")
    .select("*")
    .eq("organization_id", orgId)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1000);

  if (isCheckType(req.query.check_type)) query = query.eq("check_type", req.query.check_type);
  if (typeof req.query.employee_id === "string" && req.query.employee_id) {
    query = query.eq("employee_id", req.query.employee_id);
  }
  if (typeof req.query.start_date === "string" && req.query.start_date) {
    query = query.gte("entry_date", req.query.start_date);
  }
  if (typeof req.query.end_date === "string" && req.query.end_date) {
    query = query.lte("entry_date", req.query.end_date);
  }

  const { data, error } = await query;
  if (error) return sendSafeError(res, 500, "Failed to load bonus entries.", "quality bonus entries select:", error);
  return res.json(data);
});

router.post("/quality/bonus-entries", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const userId = req.userId;
  const body = req.body as Record<string, unknown>;

  const employee_id = typeof body.employee_id === "string" ? body.employee_id.trim() : "";
  const entry_date = typeof body.entry_date === "string" ? body.entry_date.trim() : "";
  const entered_speed = Number(body.entered_speed);
  const hours_worked = Number(body.hours_worked);

  if (!employee_id) return res.status(400).json({ message: "employee_id is required" });
  if (!entry_date) return res.status(400).json({ message: "entry_date is required" });
  if (!isCheckType(body.check_type)) return res.status(400).json({ message: "check_type is required" });
  if (!Number.isFinite(entered_speed) || entered_speed < 0) {
    return res.status(400).json({ message: "entered_speed cannot be negative" });
  }
  if (!Number.isFinite(hours_worked) || hours_worked <= 0) {
    return res.status(400).json({ message: "hours_worked must be greater than 0" });
  }

  const { data: emp, error: empError } = await supabase
    .from("quality_employees")
    .select("id, name")
    .eq("id", employee_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (empError) return sendSafeError(res, 500, "Failed to validate employee.", "quality bonus entry employee lookup:", empError);
  if (!emp) return res.status(400).json({ message: "Employee not found" });

  let applied: Awaited<ReturnType<typeof computeBonus>>;
  try {
    applied = await computeBonus(orgId, body.check_type, entered_speed);
  } catch (err) {
    return sendSafeError(res, 500, "Failed to calculate bonus.", "quality bonus entry tier lookup:", err);
  }

  const total_bonus = round2(applied.applied_rate * hours_worked);

  const { data, error } = await supabase
    .from("quality_bonus_entries")
    .insert({
      organization_id: orgId,
      employee_id,
      employee_name: emp.name,
      entry_date,
      check_type: body.check_type,
      entered_speed,
      speed_unit: speedUnitFor(body.check_type),
      hours_worked,
      applied_threshold: applied.applied_threshold,
      applied_rate: applied.applied_rate,
      base_threshold: applied.base_threshold,
      raw_adjustment: applied.raw_adjustment,
      final_adjustment: applied.final_adjustment,
      total_bonus,
      created_by: userId
    })
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to save bonus entry.", "quality bonus entry insert:", error);
  return res.status(201).json(data);
});

router.patch("/quality/bonus-entries/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const userId = req.userId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const { data: existing, error: existingError } = await supabase
    .from("quality_bonus_entries")
    .select("*")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (existingError) return sendSafeError(res, 500, "Failed to look up bonus entry.", "quality bonus entry lookup:", existingError);
  if (!existing) return res.status(404).json({ message: "Bonus entry not found" });

  const employee_id = typeof body.employee_id === "string" && body.employee_id.trim() ? body.employee_id.trim() : existing.employee_id;
  const entry_date = typeof body.entry_date === "string" && body.entry_date.trim() ? body.entry_date.trim() : existing.entry_date;
  const check_type = isCheckType(body.check_type) ? body.check_type : (existing.check_type as CheckType);
  const entered_speed = body.entered_speed !== undefined ? Number(body.entered_speed) : Number(existing.entered_speed);
  const hours_worked = body.hours_worked !== undefined ? Number(body.hours_worked) : Number(existing.hours_worked);

  if (!Number.isFinite(entered_speed) || entered_speed < 0) {
    return res.status(400).json({ message: "entered_speed cannot be negative" });
  }
  if (!Number.isFinite(hours_worked) || hours_worked <= 0) {
    return res.status(400).json({ message: "hours_worked must be greater than 0" });
  }

  let employee_name = existing.employee_name;
  if (employee_id !== existing.employee_id) {
    const { data: emp, error: empError } = await supabase
      .from("quality_employees")
      .select("id, name")
      .eq("id", employee_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (empError) return sendSafeError(res, 500, "Failed to validate employee.", "quality bonus entry employee lookup (patch):", empError);
    if (!emp) return res.status(400).json({ message: "Employee not found" });
    employee_name = emp.name;
  }

  // Reuse the entry's own saved weekly conditions (if any) so a correction
  // to speed/hours recomputes within the same weekly context it was
  // originally imported under, rather than losing the adjustment entirely.
  let applied: Awaited<ReturnType<typeof computeBonus>>;
  try {
    applied = await computeBonus(orgId, check_type, entered_speed, {
      cropLoad: existing.weekly_crop_load,
      setsPerPlant: existing.weekly_sets_per_plant
    });
  } catch (err) {
    return sendSafeError(res, 500, "Failed to calculate bonus.", "quality bonus entry tier lookup (patch):", err);
  }

  const total_bonus = round2(applied.applied_rate * hours_worked);

  const { data, error } = await supabase
    .from("quality_bonus_entries")
    .update({
      employee_id,
      employee_name,
      entry_date,
      check_type,
      entered_speed,
      speed_unit: speedUnitFor(check_type),
      hours_worked,
      applied_threshold: applied.applied_threshold,
      applied_rate: applied.applied_rate,
      base_threshold: applied.base_threshold,
      raw_adjustment: applied.raw_adjustment,
      final_adjustment: applied.final_adjustment,
      total_bonus,
      updated_at: new Date().toISOString(),
      updated_by: userId
    })
    .eq("id", id)
    .eq("organization_id", orgId)
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to update bonus entry.", "quality bonus entry update:", error);
  return res.json(data);
});

router.delete("/quality/bonus-entries/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;
  const { error } = await supabase
    .from("quality_bonus_entries")
    .delete()
    .eq("id", id)
    .eq("organization_id", orgId);
  if (error) return sendSafeError(res, 500, "Failed to delete bonus entry.", "quality bonus entry delete:", error);
  return res.json({ deleted: true });
});

export { router as qualityBonusesRouter };
