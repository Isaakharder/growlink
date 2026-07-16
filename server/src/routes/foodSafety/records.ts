import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission, requirePermission } from "../../middleware/requirePermission";
import { orgScopedTable } from "./services/orgScopedTable";
import { userHasPermission } from "./services/permissionCheck";
import { ensureDepartmentExists } from "./locations";
import type { FoodSafetyFormSchema } from "./services/templateSchema";
import { validateAnswers } from "./services/recordValidation";
import { resolveActiveEmployee, isDraftOwner, ensureRecordViewable } from "./services/recordPermissions";
import { RecordApiError, getRecordOrThrow, logAuditEvent } from "./services/recordRevisions";
import type { FoodSafetyRecordRow } from "./types";

function from(table: string) {
  return (supabase as any).from(table); // eslint-disable-line @typescript-eslint/no-explicit-any
}

function handleRecordApiError(res: import("express").Response, error: unknown, logContext: string) {
  if (error instanceof RecordApiError) {
    return res.status(error.status).json({ message: error.message });
  }
  return sendSafeError(res, 500, "Something went wrong.", logContext, error);
}

async function ensureLocationExists(locationId: string, organizationId: string): Promise<void> {
  const { data, error } = await supabase
    .from("food_safety_locations")
    .select("id")
    .eq("id", locationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new RecordApiError(500, "Failed to verify location.");
  if (!data) throw new RecordApiError(400, "Selected location/asset was not found in this organization.");
}

// Exported so records.integration.test.ts can verify directly that only a
// published version is ever returned (drafts are ignored) without needing
// to drive the full HTTP route.
export async function getLatestPublishedVersion(organizationId: string, templateId: string) {
  const { data, error } = await from("food_safety_form_template_versions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("template_id", templateId)
    .eq("status", "published")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new RecordApiError(500, "Failed to load the published form.");
  return data as { id: string; version_number: number; schema_json: FoodSafetyFormSchema } | null;
}

const recordsRouter = Router();

// ── permission gates ─────────────────────────────────────────────────────────
const canViewRecords = requireAnyPermission(["food_safety:view", "food_safety:complete", "food_safety:verify"]);
const canComplete = requirePermission("food_safety:complete");
const canVerify = requirePermission("food_safety:verify");
const mobileGate = requirePermission("mobile:food_safety");
const mobileContentGate = requireAnyPermission(["food_safety:complete", "food_safety:verify"]);

// ── employees (needed for employee_selector fields + the mobile "who is
// completing this" picker) ──────────────────────────────────────────────────

// GET /food-safety/employees — active employees in the organization
recordsRouter.get("/food-safety/employees", canViewRecords, async (req, res) => {
  const { data, error } = await supabase
    .from("employees")
    .select("id, employee_code, first_name, last_name, display_name, active, user_id")
    .eq("organization_id", req.organizationId)
    .eq("active", true)
    .order("display_name", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load employees.", "Food safety employees list error:", error);
  }
  return res.json(data ?? []);
});

// ── mobile: browse available forms ──────────────────────────────────────────

// GET /food-safety/mobile/forms — published, active forms available to complete
recordsRouter.get("/food-safety/mobile/forms", mobileGate, mobileContentGate, async (req, res) => {
  const organizationId = req.organizationId;
  const departmentId = typeof req.query.department_id === "string" ? req.query.department_id : undefined;

  const scope = orgScopedTable("food_safety_form_templates", organizationId);
  let templatesQuery = scope.selectAll().eq("active", true);
  if (departmentId) templatesQuery = templatesQuery.eq("department_id", departmentId);
  const templatesResult = await templatesQuery.order("sort_order", { ascending: true });

  if (templatesResult.error) {
    return sendSafeError(res, 500, "Failed to load forms.", "Food safety mobile forms list error:", templatesResult.error);
  }

  const templates = (templatesResult.data ?? []) as Array<{
    id: string;
    name: string;
    description: string | null;
    instructions: string | null;
    department_id: string | null;
  }>;
  if (templates.length === 0) return res.json([]);

  const [versionsResult, departmentsResult] = await Promise.all([
    orgScopedTable("food_safety_form_template_versions", organizationId)
      .selectAll("template_id, version_number")
      .eq("status", "published")
      .in(
        "template_id",
        templates.map((t) => t.id)
      ),
    orgScopedTable("food_safety_departments", organizationId).selectAll("id, name")
  ]);

  if (versionsResult.error) {
    return sendSafeError(res, 500, "Failed to load forms.", "Food safety mobile forms versions error:", versionsResult.error);
  }

  const latestPublishedByTemplate = new Map<string, number>();
  for (const row of (versionsResult.data ?? []) as Array<{ template_id: string; version_number: number }>) {
    const current = latestPublishedByTemplate.get(row.template_id) ?? 0;
    if (row.version_number > current) latestPublishedByTemplate.set(row.template_id, row.version_number);
  }

  const departmentNameById = new Map(
    ((departmentsResult.data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name])
  );

  const forms = templates
    .filter((template) => latestPublishedByTemplate.has(template.id))
    .map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      hasInstructions: Boolean(template.instructions && template.instructions.trim().length > 0),
      departmentId: template.department_id,
      departmentName: template.department_id ? departmentNameById.get(template.department_id) ?? null : null,
      latestPublishedVersionNumber: latestPublishedByTemplate.get(template.id)
    }));

  return res.json(forms);
});

// GET /food-safety/mobile/forms/:templateId — latest published version + schema
recordsRouter.get("/food-safety/mobile/forms/:templateId", mobileGate, mobileContentGate, async (req, res) => {
  const organizationId = req.organizationId;
  const templateId = req.params.templateId as string;

  const { data: template, error: templateError } = await orgScopedTable("food_safety_form_templates", organizationId).selectById(
    templateId
  );
  if (templateError) return sendSafeError(res, 500, "Failed to load form.", "Food safety mobile form fetch error:", templateError);
  if (!template || !(template as { active: boolean }).active) {
    return res.status(404).json({ message: "Form not found or not currently available." });
  }

  const version = await getLatestPublishedVersion(organizationId, templateId).catch((error) => {
    throw error;
  });
  if (!version) {
    return res.status(404).json({ message: "This form has no published version yet." });
  }

  return res.json({ template, version });
});

// ── record creation & draft editing ──────────────────────────────────────────

type CreateRecordPayload = {
  template_id: string;
  department_id: string | null;
  location_id: string | null;
  employee_id: string | null;
  record_date: string | null;
};

async function parseCreateRecordPayload(input: unknown, organizationId: string): Promise<CreateRecordPayload> {
  if (!input || typeof input !== "object") throw new Error("Invalid request body");
  const body = input as Record<string, unknown>;

  const templateId = typeof body.template_id === "string" ? body.template_id : "";
  if (!templateId) throw new Error("template_id is required");

  const departmentId = typeof body.department_id === "string" && body.department_id ? body.department_id : null;
  if (departmentId) await ensureDepartmentExists(departmentId, organizationId);

  const locationId = typeof body.location_id === "string" && body.location_id ? body.location_id : null;
  if (locationId) await ensureLocationExists(locationId, organizationId);

  const employeeId = typeof body.employee_id === "string" && body.employee_id ? body.employee_id : null;
  if (employeeId) await resolveActiveEmployee(organizationId, employeeId);

  let recordDate: string | null = null;
  if (body.record_date !== undefined && body.record_date !== null && body.record_date !== "") {
    if (typeof body.record_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.record_date)) {
      throw new Error("record_date must be a valid date (YYYY-MM-DD)");
    }
    recordDate = body.record_date;
  }

  return { template_id: templateId, department_id: departmentId, location_id: locationId, employee_id: employeeId, record_date: recordDate };
}

// POST /food-safety/records — create a draft from a published template version
recordsRouter.post("/food-safety/records", canComplete, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: CreateRecordPayload;

  try {
    payload = await parseCreateRecordPayload(req.body, organizationId);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  try {
    const { data: template, error: templateError } = await orgScopedTable("food_safety_form_templates", organizationId).selectById(
      payload.template_id
    );
    if (templateError) throw new RecordApiError(500, "Failed to load template.");
    const templateRow = template as { id: string; active: boolean; department_id: string | null } | null;
    if (!templateRow) throw new RecordApiError(404, "Template not found.");
    if (!templateRow.active) {
      throw new RecordApiError(400, "This template is inactive and cannot be used to start a new record.");
    }

    const version = await getLatestPublishedVersion(organizationId, payload.template_id);
    if (!version) {
      throw new RecordApiError(400, "This form has no published version yet.");
    }

    const scope = orgScopedTable("food_safety_records", organizationId);
    const insertPayload: Record<string, unknown> = {
      template_id: payload.template_id,
      template_version_id: version.id,
      department_id: payload.department_id ?? templateRow.department_id,
      location_id: payload.location_id,
      completed_by_employee_id: payload.employee_id,
      completed_by_user_id: req.userId,
      status: "draft",
      answers_json: {},
      current_revision_number: 0
    };
    if (payload.record_date) insertPayload.record_date = payload.record_date;

    const { data, error } = await scope.insert(insertPayload);
    if (error) return sendSafeError(res, 500, "Failed to create record.", "Food safety record insert error:", error);

    const record = data as FoodSafetyRecordRow;
    await logAuditEvent({
      organizationId,
      recordId: record.id,
      eventType: "record_created",
      actorUserId: req.userId ?? null,
      actorEmployeeId: record.completed_by_employee_id
    });

    return res.status(201).json(record);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety record create error:");
  }
});

// GET /food-safety/records/awaiting-verification — must be registered before
// the "/food-safety/records/:id" route below: Express matches routes in
// registration order, and ":id" would otherwise swallow this literal path
// (treating "awaiting-verification" as an id and failing with an invalid
// UUID error surfaced to the client as "Failed to load record.").
recordsRouter.get("/food-safety/records/awaiting-verification", canVerify, async (req, res) => {
  const organizationId = req.organizationId;
  const scope = orgScopedTable("food_safety_records", organizationId);

  const { data, error } = await scope
    .selectAll()
    .in("status", ["submitted", "amended"])
    .order("submitted_at", { ascending: true });

  if (error) return sendSafeError(res, 500, "Failed to load records awaiting verification.", "Food safety awaiting-verification error:", error);
  return res.json(data ?? []);
});

// GET /food-safety/records/:id — record detail (ownership-aware for drafts)
recordsRouter.get("/food-safety/records/:id", canViewRecords, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;

  try {
    const record = await getRecordOrThrow(organizationId, id);
    await ensureRecordViewable(req, record);

    const { data: version, error: versionError } = await from("food_safety_form_template_versions")
      .select("id, version_number, schema_json")
      .eq("id", record.template_version_id)
      .maybeSingle();
    if (versionError) return sendSafeError(res, 500, "Failed to load record.", "Food safety record version fetch error:", versionError);

    return res.json({ record, schema: version?.schema_json ?? null, versionNumber: version?.version_number ?? null });
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety record fetch error:");
  }
});

// PUT /food-safety/records/:id/draft — update draft answers (owner only, strict)
recordsRouter.put("/food-safety/records/:id/draft", canComplete, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;
  const body = (req.body ?? {}) as { answers_json?: unknown; employee_id?: unknown };

  try {
    const record = await getRecordOrThrow(organizationId, id);

    if (!isDraftOwner(record, req.userId ?? null)) {
      throw new RecordApiError(403, "Only the person who started this draft may edit it.");
    }
    if (record.status !== "draft") {
      throw new RecordApiError(409, "This record is no longer a draft and cannot be edited this way.");
    }

    const { data: versionRow, error: versionError } = await from("food_safety_form_template_versions")
      .select("schema_json")
      .eq("id", record.template_version_id)
      .maybeSingle();
    if (versionError || !versionRow) throw new RecordApiError(500, "Failed to load form schema.");
    const schema = versionRow.schema_json as FoodSafetyFormSchema;

    const validation = await validateAnswers(schema, body.answers_json ?? {}, organizationId, "draft");
    if (!validation.valid) {
      return res.status(400).json({ message: validation.errors.join(" ") });
    }

    const updates: Record<string, unknown> = { answers_json: validation.answers, updated_at: new Date().toISOString() };
    if (typeof body.employee_id === "string" && body.employee_id) {
      await resolveActiveEmployee(organizationId, body.employee_id);
      updates.completed_by_employee_id = body.employee_id;
    }

    const scope = orgScopedTable("food_safety_records", organizationId);
    const { data, error } = await scope.update(id, updates);
    if (error) return sendSafeError(res, 500, "Failed to save draft.", "Food safety draft update error:", error);
    if (!data) return res.status(409).json({ message: "This record is no longer a draft and cannot be edited this way." });

    await logAuditEvent({
      organizationId,
      recordId: id,
      eventType: "draft_saved",
      actorUserId: req.userId ?? null,
      actorEmployeeId: (data as FoodSafetyRecordRow).completed_by_employee_id
    });

    return res.json(data);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety draft update error:");
  }
});

// ── desktop / mobile listing ─────────────────────────────────────────────────

// GET /food-safety/records — desktop list. Never includes drafts (those live
// in the mobile "My Drafts" view). A complete-only caller (no view/verify)
// only ever sees their own records; view/verify holders (and owner/admin,
// via the same bypass) see every record in the organization.
recordsRouter.get("/food-safety/records", canViewRecords, async (req, res) => {
  const organizationId = req.organizationId;
  const scope = orgScopedTable("food_safety_records", organizationId);

  let query = scope.selectAll().neq("status", "draft");

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status) query = query.eq("status", status);
  const templateId = typeof req.query.template_id === "string" ? req.query.template_id : undefined;
  if (templateId) query = query.eq("template_id", templateId);
  const departmentId = typeof req.query.department_id === "string" ? req.query.department_id : undefined;
  if (departmentId) query = query.eq("department_id", departmentId);
  const employeeId = typeof req.query.employee_id === "string" ? req.query.employee_id : undefined;
  if (employeeId) query = query.eq("completed_by_employee_id", employeeId);
  const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from : undefined;
  if (dateFrom) query = query.gte("record_date", dateFrom);
  const dateTo = typeof req.query.date_to === "string" ? req.query.date_to : undefined;
  if (dateTo) query = query.lte("record_date", dateTo);

  const broadAccess = await userHasPermission(req, "food_safety:view");
  const canVerifyAccess = broadAccess ? true : await userHasPermission(req, "food_safety:verify");
  if (!broadAccess && !canVerifyAccess) {
    query = query.eq("completed_by_user_id", req.userId);
  }

  const { data, error } = await query.order("record_date", { ascending: false }).order("created_at", { ascending: false });
  if (error) return sendSafeError(res, 500, "Failed to load records.", "Food safety records list error:", error);

  return res.json(data ?? []);
});

// GET /food-safety/mobile/recent — the current user's (or a chosen employee's) recent records
recordsRouter.get("/food-safety/mobile/recent", mobileGate, mobileContentGate, async (req, res) => {
  const organizationId = req.organizationId;
  const scope = orgScopedTable("food_safety_records", organizationId);
  const employeeIdParam = typeof req.query.employee_id === "string" ? req.query.employee_id : undefined;

  let query = scope.selectAll();
  if (employeeIdParam) {
    query = query.eq("completed_by_employee_id", employeeIdParam);
  } else {
    query = query.eq("completed_by_user_id", req.userId);
  }

  const { data, error } = await query.order("updated_at", { ascending: false }).limit(20);
  if (error) return sendSafeError(res, 500, "Failed to load recent records.", "Food safety mobile recent error:", error);
  return res.json(data ?? []);
});

export { recordsRouter };
