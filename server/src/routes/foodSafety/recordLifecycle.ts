import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission, requirePermission } from "../../middleware/requirePermission";
import { userHasPermission } from "./services/permissionCheck";
import { readRequiresVerification, type FoodSafetyFormSchema } from "./services/templateSchema";
import { validateAnswers } from "./services/recordValidation";
import { resolveActiveEmployee, isDraftOwner, ensureRecordViewable, wouldBeSelfVerification } from "./services/recordPermissions";
import {
  RecordApiError,
  amendRecord,
  computeAnswerChanges,
  getRecordOrThrow,
  listAuditEvents,
  listChanges,
  listRevisions,
  rejectRecord,
  resolveMetadataSnapshot,
  resubmitRecord,
  submitRecord,
  verifyRecord
} from "./services/recordRevisions";
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

async function loadSchemaAndTemplateInfo(record: FoodSafetyRecordRow) {
  const [versionResult, templateResult] = await Promise.all([
    from("food_safety_form_template_versions").select("schema_json, version_number").eq("id", record.template_version_id).maybeSingle(),
    from("food_safety_form_templates").select("name, form_code, canadagap_section").eq("id", record.template_id).maybeSingle()
  ]);

  if (versionResult.error || !versionResult.data) {
    throw new RecordApiError(500, "Failed to load the form used for this record.");
  }
  if (templateResult.error || !templateResult.data) {
    throw new RecordApiError(500, "Failed to load the template for this record.");
  }

  const schema = versionResult.data.schema_json as FoodSafetyFormSchema;
  const templateInfo = {
    templateName: templateResult.data.name as string,
    formCode: (templateResult.data.form_code as string | null) ?? null,
    canadagapSection: (templateResult.data.canadagap_section as string | null) ?? null,
    versionNumber: versionResult.data.version_number as number
  };

  return { schema, templateInfo };
}

const recordLifecycleRouter = Router();

const canViewRecords = requireAnyPermission(["food_safety:view", "food_safety:complete", "food_safety:verify"]);
const canComplete = requirePermission("food_safety:complete");
const canVerify = requirePermission("food_safety:verify");
const canAmend = requireAnyPermission(["food_safety:complete", "food_safety:verify"]);

// POST /food-safety/records/:id/submit
recordLifecycleRouter.post("/food-safety/records/:id/submit", canComplete, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;
  const body = (req.body ?? {}) as { answers_json?: unknown; employee_id?: unknown };

  try {
    const record = await getRecordOrThrow(organizationId, id);
    if (!isDraftOwner(record, req.userId ?? null)) {
      throw new RecordApiError(403, "Only the person who started this draft may submit it.");
    }
    if (record.status !== "draft") {
      throw new RecordApiError(409, "This record has already been submitted.");
    }

    if (typeof body.employee_id !== "string" || !body.employee_id) {
      throw new RecordApiError(400, "A valid employee identity is required to submit a record.");
    }
    const employee = await resolveActiveEmployee(organizationId, body.employee_id);

    const { schema, templateInfo } = await loadSchemaAndTemplateInfo(record);

    const validation = await validateAnswers(schema, body.answers_json ?? record.answers_json, organizationId, "submit");
    if (!validation.valid) {
      return res.status(400).json({ message: validation.errors.join(" ") });
    }

    const requiresVerification = readRequiresVerification(schema);
    const metadataSnapshot = await resolveMetadataSnapshot(
      organizationId,
      { ...record, completed_by_employee_id: employee.id },
      templateInfo
    );

    const updated = await submitRecord({
      organizationId,
      recordId: id,
      answersJson: validation.answers,
      completedByEmployeeId: employee.id,
      completedByUserId: req.userId ?? null,
      requiresVerification,
      metadataSnapshot
    });

    return res.json(updated);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety record submit error:");
  }
});

// POST /food-safety/records/:id/verify
recordLifecycleRouter.post("/food-safety/records/:id/verify", canVerify, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;
  const body = (req.body ?? {}) as { employee_id?: unknown };

  try {
    const record = await getRecordOrThrow(organizationId, id);

    let verifierEmployeeId: string | null = null;
    if (typeof body.employee_id === "string" && body.employee_id) {
      const employee = await resolveActiveEmployee(organizationId, body.employee_id);
      verifierEmployeeId = employee.id;
    }

    if (wouldBeSelfVerification(record, req.userId ?? null, verifierEmployeeId)) {
      throw new RecordApiError(403, "You cannot verify your own submitted record.");
    }
    if (record.status !== "submitted" && record.status !== "amended") {
      throw new RecordApiError(409, "This record is not awaiting verification.");
    }

    const { templateInfo } = await loadSchemaAndTemplateInfo(record);
    const metadataSnapshot = await resolveMetadataSnapshot(organizationId, record, templateInfo);

    const updated = await verifyRecord({
      organizationId,
      recordId: id,
      verifiedByUserId: req.userId ?? null,
      verifiedByEmployeeId: verifierEmployeeId,
      metadataSnapshot
    });

    return res.json(updated);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety record verify error:");
  }
});

// POST /food-safety/records/:id/reject
recordLifecycleRouter.post("/food-safety/records/:id/reject", canVerify, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;
  const body = (req.body ?? {}) as { reason?: unknown };

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return res.status(400).json({ message: "A rejection reason is required." });
  }

  try {
    const record = await getRecordOrThrow(organizationId, id);
    if (record.status !== "submitted" && record.status !== "amended") {
      throw new RecordApiError(409, "This record is not awaiting verification and cannot be rejected.");
    }

    const { templateInfo } = await loadSchemaAndTemplateInfo(record);
    const metadataSnapshot = await resolveMetadataSnapshot(organizationId, record, templateInfo);

    const updated = await rejectRecord({
      organizationId,
      recordId: id,
      rejectedByUserId: req.userId ?? null,
      rejectionReason: reason,
      metadataSnapshot
    });

    return res.json(updated);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety record reject error:");
  }
});

// POST /food-safety/records/:id/resubmit — correct a rejected record and resubmit
recordLifecycleRouter.post("/food-safety/records/:id/resubmit", canComplete, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;
  const body = (req.body ?? {}) as { answers_json?: unknown; employee_id?: unknown; change_reason?: unknown };

  try {
    const record = await getRecordOrThrow(organizationId, id);
    if (!isDraftOwner(record, req.userId ?? null)) {
      throw new RecordApiError(403, "Only the person who completed this record may resubmit it.");
    }
    if (record.status !== "rejected") {
      throw new RecordApiError(409, "Only a rejected record can be resubmitted.");
    }

    if (typeof body.employee_id !== "string" || !body.employee_id) {
      throw new RecordApiError(400, "A valid employee identity is required to resubmit a record.");
    }
    const employee = await resolveActiveEmployee(organizationId, body.employee_id);

    const { schema, templateInfo } = await loadSchemaAndTemplateInfo(record);
    const validation = await validateAnswers(schema, body.answers_json ?? record.answers_json, organizationId, "submit");
    if (!validation.valid) {
      return res.status(400).json({ message: validation.errors.join(" ") });
    }

    const changes = computeAnswerChanges(record.answers_json, validation.answers);
    const changeReason = typeof body.change_reason === "string" ? body.change_reason.trim() : "";
    if (changes.length > 0 && !changeReason) {
      return res.status(400).json({ message: "A reason is required because the answers have changed." });
    }

    const requiresVerification = readRequiresVerification(schema);
    const metadataSnapshot = await resolveMetadataSnapshot(
      organizationId,
      { ...record, completed_by_employee_id: employee.id },
      templateInfo
    );

    const updated = await resubmitRecord({
      organizationId,
      recordId: id,
      answersJson: validation.answers,
      completedByEmployeeId: employee.id,
      completedByUserId: req.userId ?? null,
      requiresVerification,
      changeReason: changeReason || null,
      changes,
      metadataSnapshot
    });

    return res.json(updated);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety record resubmit error:");
  }
});

// POST /food-safety/records/:id/amend — explicit post-submission/verification correction
recordLifecycleRouter.post("/food-safety/records/:id/amend", canAmend, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;
  const body = (req.body ?? {}) as { answers_json?: unknown; reason?: unknown; employee_id?: unknown };

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return res.status(400).json({ message: "An amendment reason is required." });
  }

  try {
    const record = await getRecordOrThrow(organizationId, id);

    const canManageAnyRecord = await userHasPermission(req, "food_safety:verify");
    if (!canManageAnyRecord && record.completed_by_user_id !== (req.userId ?? null)) {
      throw new RecordApiError(403, "You do not have permission to amend this record.");
    }
    if (!["submitted", "verified", "amended"].includes(record.status)) {
      throw new RecordApiError(409, "Only a submitted, verified, or previously amended record can be amended.");
    }

    let amendedByEmployeeId: string | null = null;
    if (typeof body.employee_id === "string" && body.employee_id) {
      const employee = await resolveActiveEmployee(organizationId, body.employee_id);
      amendedByEmployeeId = employee.id;
    }

    const { schema, templateInfo } = await loadSchemaAndTemplateInfo(record);
    const validation = await validateAnswers(schema, body.answers_json ?? record.answers_json, organizationId, "submit");
    if (!validation.valid) {
      return res.status(400).json({ message: validation.errors.join(" ") });
    }

    const changes = computeAnswerChanges(record.answers_json, validation.answers);
    const metadataSnapshot = await resolveMetadataSnapshot(organizationId, record, templateInfo);

    const updated = await amendRecord({
      organizationId,
      recordId: id,
      answersJson: validation.answers,
      amendedByEmployeeId,
      amendedByUserId: req.userId ?? null,
      reason,
      changes,
      metadataSnapshot
    });

    return res.json(updated);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety record amend error:");
  }
});

// GET /food-safety/records/:id/revisions
recordLifecycleRouter.get("/food-safety/records/:id/revisions", canViewRecords, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;

  try {
    const record = await getRecordOrThrow(organizationId, id);
    await ensureRecordViewable(req, record);

    const [revisions, changes] = await Promise.all([listRevisions(organizationId, id), listChanges(organizationId, id)]);

    const changesByRevision = new Map<number, typeof changes>();
    for (const change of changes as Array<{ to_revision_number: number }>) {
      const list = changesByRevision.get(change.to_revision_number) ?? [];
      list.push(change as never);
      changesByRevision.set(change.to_revision_number, list);
    }

    const withChanges = (revisions as Array<{ revision_number: number }>).map((revision) => ({
      ...revision,
      changes: changesByRevision.get(revision.revision_number) ?? []
    }));

    return res.json(withChanges);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety revisions list error:");
  }
});

// GET /food-safety/records/:id/audit-events
recordLifecycleRouter.get("/food-safety/records/:id/audit-events", canViewRecords, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;

  try {
    const record = await getRecordOrThrow(organizationId, id);
    await ensureRecordViewable(req, record);

    const events = await listAuditEvents(organizationId, id);
    return res.json(events);
  } catch (error) {
    return handleRecordApiError(res, error, "Food safety audit events list error:");
  }
});

export { recordLifecycleRouter };
