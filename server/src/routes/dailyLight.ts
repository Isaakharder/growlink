import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission } from "../middleware/requirePermission";

const router = Router();

// Requires the same permission as the Environment page gate.
const canAccess = requireAnyPermission(["irrigation:view"]);

function isValidDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// GET /api/daily-light?days=N
// Returns org-scoped entries sorted by log_date desc, up to N days back.
router.get("/daily-light", canAccess, async (req, res) => {
  const orgId = req.organizationId;

  const rawDays = parseInt(String(req.query.days ?? "1095"), 10);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 1825) : 1095;

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_light_logs")
    .select("id, log_date, joules_per_cm2, notes, created_at, updated_at")
    .eq("organization_id", orgId)
    .gte("log_date", sinceStr)
    .order("log_date", { ascending: false });

  if (error) {
    return sendSafeError(res, 500, "Failed to load daily light logs.", "daily-light select:", error);
  }

  return res.json(data);
});

// POST /api/daily-light
// Upserts one entry per organization per date.
router.post("/daily-light", canAccess, async (req, res) => {
  const orgId = req.organizationId;
  const body = req.body as Record<string, unknown>;

  const rawDate = typeof body.log_date === "string" ? body.log_date.trim() : "";
  if (!isValidDateString(rawDate)) {
    return res.status(400).json({ message: "log_date must be YYYY-MM-DD" });
  }

  const rawJoules = body.joules_per_cm2;
  const joules = typeof rawJoules === "number" ? rawJoules : Number(rawJoules);
  if (!Number.isFinite(joules) || joules < 0) {
    return res.status(400).json({ message: "joules_per_cm2 must be 0 or greater" });
  }

  const notes =
    typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

  const { data, error } = await supabase
    .from("daily_light_logs")
    .upsert(
      {
        organization_id: orgId,
        log_date: rawDate,
        joules_per_cm2: joules,
        notes,
        updated_at: new Date().toISOString()
      },
      { onConflict: "organization_id,log_date" }
    )
    .select("id, log_date, joules_per_cm2, notes, created_at, updated_at")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to save daily light log.", "daily-light upsert:", error);
  }

  return res.status(201).json(data);
});

// DELETE /api/daily-light/:id
// Deletes by id scoped to the caller's organization.
router.delete("/daily-light/:id", canAccess, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("daily_light_logs")
    .delete()
    .eq("id", id)
    .eq("organization_id", orgId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete daily light log.", "daily-light delete:", error);
  }

  return res.status(204).send();
});

export { router as dailyLightRouter };
