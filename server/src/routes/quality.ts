import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

const router = Router();

const canView = requireAnyPermission(["mobile:quality", "quality:view", "quality:edit"]);
const canEdit = requireAnyPermission(["mobile:quality", "quality:edit"]);

// ── Employees ──────────────────────────────────────────────────────────────

router.get("/quality/employees", canView, async (req, res) => {
  const orgId = req.organizationId;
  const { data, error } = await supabase
    .from("quality_employees")
    .select("*")
    .eq("organization_id", orgId)
    .order("name");
  if (error) return sendSafeError(res, 500, "Failed to load employees.", "quality employees select:", error);
  return res.json(data);
});

router.post("/quality/employees", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const body = req.body as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return res.status(400).json({ message: "name is required" });
  const { data, error } = await supabase
    .from("quality_employees")
    .insert({ organization_id: orgId, name, active: true })
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to create employee.", "quality employee insert:", error);
  return res.status(201).json(data);
});

router.patch("/quality/employees/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof body.active === "boolean") updates.active = body.active;
  if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
  if (Object.keys(updates).length === 0) return res.status(400).json({ message: "Nothing to update" });
  const { data, error } = await supabase
    .from("quality_employees")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", orgId)
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to update employee.", "quality employee update:", error);
  return res.json(data);
});

router.delete("/quality/employees/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;

  const { data: emp, error: empError } = await supabase
    .from("quality_employees")
    .select("id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (empError) return sendSafeError(res, 500, "Failed to look up employee.", "quality employee delete lookup:", empError);
  if (!emp) return res.status(404).json({ message: "Employee not found" });

  const { count, error: countError } = await supabase
    .from("quality_checks")
    .select("id", { count: "exact", head: true })
    .eq("employee_id", id)
    .eq("organization_id", orgId);
  if (countError) return sendSafeError(res, 500, "Failed to check records.", "quality employee record count:", countError);

  if (count && count > 0) {
    const { error: archiveError } = await supabase
      .from("quality_employees")
      .update({ active: false })
      .eq("id", id)
      .eq("organization_id", orgId);
    if (archiveError) return sendSafeError(res, 500, "Failed to archive employee.", "quality employee archive:", archiveError);
    return res.json({ archived: true });
  }

  const { error: deleteError } = await supabase
    .from("quality_employees")
    .delete()
    .eq("id", id)
    .eq("organization_id", orgId);
  if (deleteError) return sendSafeError(res, 500, "Failed to delete employee.", "quality employee delete:", deleteError);
  return res.json({ deleted: true });
});

router.delete("/quality/employees/:id/permanent", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;

  const { data: emp, error: empError } = await supabase
    .from("quality_employees")
    .select("id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (empError) return sendSafeError(res, 500, "Failed to look up employee.", "quality employee permanent delete lookup:", empError);
  if (!emp) return res.status(404).json({ message: "Employee not found" });

  const { error: checksError } = await supabase
    .from("quality_checks")
    .delete()
    .eq("employee_id", id)
    .eq("organization_id", orgId);
  if (checksError) return sendSafeError(res, 500, "Failed to delete check records.", "quality employee checks delete:", checksError);

  const { error: empDeleteError } = await supabase
    .from("quality_employees")
    .delete()
    .eq("id", id)
    .eq("organization_id", orgId);
  if (empDeleteError) return sendSafeError(res, 500, "Failed to delete employee.", "quality employee permanent delete:", empDeleteError);

  return res.json({ deleted: true });
});

// ── Metrics ────────────────────────────────────────────────────────────────

router.get("/quality/metrics", canView, async (req, res) => {
  const orgId = req.organizationId;
  const { data, error } = await supabase
    .from("quality_metrics")
    .select("*")
    .eq("organization_id", orgId)
    .order("name");
  if (error) return sendSafeError(res, 500, "Failed to load metrics.", "quality metrics select:", error);
  return res.json(data);
});

router.post("/quality/metrics", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const body = req.body as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return res.status(400).json({ message: "name is required" });
  const { data, error } = await supabase
    .from("quality_metrics")
    .insert({ organization_id: orgId, name, active: true })
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to create metric.", "quality metric insert:", error);
  return res.status(201).json(data);
});

router.patch("/quality/metrics/:id", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof body.active === "boolean") updates.active = body.active;
  if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
  if (Object.keys(updates).length === 0) return res.status(400).json({ message: "Nothing to update" });
  const { data, error } = await supabase
    .from("quality_metrics")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", orgId)
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to update metric.", "quality metric update:", error);
  return res.json(data);
});

// ── Threshold ──────────────────────────────────────────────────────────────

router.get("/quality/threshold", canView, async (req, res) => {
  const orgId = req.organizationId;
  const { data, error } = await supabase
    .from("quality_thresholds")
    .select("*")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return sendSafeError(res, 500, "Failed to load threshold.", "quality threshold select:", error);
  return res.json(data ?? { allowed_issues: 10, stems_checked: 100 });
});

router.put("/quality/threshold", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const body = req.body as Record<string, unknown>;
  const allowed_issues = Number(body.allowed_issues);
  const stems_checked = Number(body.stems_checked);
  if (!Number.isInteger(allowed_issues) || allowed_issues < 1) {
    return res.status(400).json({ message: "allowed_issues must be 1 or greater" });
  }
  if (!Number.isInteger(stems_checked) || stems_checked < 1) {
    return res.status(400).json({ message: "stems_checked must be 1 or greater" });
  }

  const { data: existing } = await supabase
    .from("quality_thresholds")
    .select("id")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from("quality_thresholds")
      .update({ allowed_issues, stems_checked, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("organization_id", orgId)
      .select()
      .single();
    if (error) return sendSafeError(res, 500, "Failed to update threshold.", "quality threshold update:", error);
    return res.json(data);
  }

  const { data, error } = await supabase
    .from("quality_thresholds")
    .insert({ organization_id: orgId, allowed_issues, stems_checked })
    .select()
    .single();
  if (error) return sendSafeError(res, 500, "Failed to create threshold.", "quality threshold insert:", error);
  return res.status(201).json(data);
});

// ── Checks ─────────────────────────────────────────────────────────────────

router.get("/quality/checks", canView, async (req, res) => {
  const orgId = req.organizationId;
  const { data, error } = await supabase
    .from("quality_checks")
    .select("*")
    .eq("organization_id", orgId)
    .order("checked_at", { ascending: false })
    .limit(500);
  if (error) return sendSafeError(res, 500, "Failed to load checks.", "quality checks select:", error);
  return res.json(data);
});

router.post("/quality/checks", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const userId = req.userId;
  const body = req.body as Record<string, unknown>;

  const employee_id = typeof body.employee_id === "string" ? body.employee_id.trim() : "";
  const phase_name = typeof body.phase_name === "string" ? body.phase_name.trim() : "";
  const row_number = Number(body.row_number);
  const stems_checked = Number(body.stems_checked);

  if (!employee_id) return res.status(400).json({ message: "employee_id is required" });
  if (!phase_name) return res.status(400).json({ message: "phase_name is required" });
  if (!Number.isInteger(row_number) || row_number < 1) {
    return res.status(400).json({ message: "row_number must be 1 or greater" });
  }
  if (!Number.isInteger(stems_checked) || stems_checked < 1) {
    return res.status(400).json({ message: "stems_checked must be 1 or greater" });
  }

  const metric_counts =
    typeof body.metric_counts === "object" && body.metric_counts !== null
      ? body.metric_counts
      : {};
  const total_issues = Number(body.total_issues) || 0;
  const notes =
    typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  const phase_id =
    typeof body.phase_id === "string" && body.phase_id ? body.phase_id : null;
  const row_id =
    typeof body.row_id === "string" && body.row_id ? body.row_id : null;

  const { data: emp, error: empError } = await supabase
    .from("quality_employees")
    .select("id")
    .eq("id", employee_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (empError) return sendSafeError(res, 500, "Failed to validate employee.", "quality check employee lookup:", empError);
  if (!emp) return res.status(400).json({ message: "Employee not found" });

  if (phase_id) {
    const { data: phase, error: phaseError } = await supabase
      .from("greenhouse_groups")
      .select("id")
      .eq("id", phase_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (phaseError) return sendSafeError(res, 500, "Failed to validate phase.", "quality check phase lookup:", phaseError);
    if (!phase) return res.status(400).json({ message: "Phase not found" });
  }

  if (row_id) {
    const { data: row, error: rowError } = await supabase
      .from("greenhouse_rows")
      .select("id")
      .eq("id", row_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (rowError) return sendSafeError(res, 500, "Failed to validate row.", "quality check row lookup:", rowError);
    if (!row) return res.status(400).json({ message: "Row not found" });
  }

  const { data, error } = await supabase
    .from("quality_checks")
    .insert({
      organization_id: orgId,
      employee_id,
      phase_id,
      phase_name,
      row_id,
      row_number,
      stems_checked,
      metric_counts,
      total_issues,
      notes,
      created_by: userId
    })
    .select()
    .single();

  if (error) return sendSafeError(res, 500, "Failed to save check.", "quality check insert:", error);
  return res.status(201).json(data);
});

export { router as qualityRouter };
