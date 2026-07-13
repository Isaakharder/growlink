import { Router } from "express";
import { sendSafeError } from "../../utils/safeError";
import { requireAnyPermission, requirePermission } from "../../middleware/requirePermission";
import { orgScopedTable } from "./services/orgScopedTable";
import { userHasPermission } from "./services/permissionCheck";
import { ensureDepartmentExists } from "./locations";
import {
  parseActive,
  parseOptionalText,
  parseRequiredName,
  parseSortOrder
} from "./services/validation";
import {
  TemplateApiError,
  cloneVersion,
  createFirstVersion,
  ensureTemplateExists,
  getVersionRow,
  listVersionSummaries,
  publishVersion,
  updateDraftVersion
} from "./services/templateVersioning";
import type { FoodSafetyFormTemplateRow } from "./types";

type TemplatePayload = {
  department_id: string | null;
  name: string;
  description: string | null;
  form_code: string | null;
  canadagap_section: string | null;
  instructions: string | null;
  active: boolean;
  sort_order: number;
};

function parseOptionalId(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
}

async function validateTemplatePayload(input: unknown, organizationId: string): Promise<TemplatePayload> {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const department_id = parseOptionalId(body.department_id, "department_id");

  if (department_id) {
    await ensureDepartmentExists(department_id, organizationId);
  }

  return {
    department_id,
    name: parseRequiredName(body.name),
    description: parseOptionalText(body.description, "description"),
    form_code: parseOptionalId(body.form_code, "form_code"),
    canadagap_section: parseOptionalText(body.canadagap_section, "canadagap_section"),
    instructions: parseOptionalText(body.instructions, "instructions"),
    active: parseActive(body.active),
    sort_order: parseSortOrder(body.sort_order)
  };
}

// Postgres unique_violation. Both food_safety_form_templates_org_name_key
// and the partial form_code unique index surface as this code.
const UNIQUE_VIOLATION = "23505";

function handleTemplateWriteError(res: import("express").Response, error: { code?: string }): import("express").Response {
  if (error.code === UNIQUE_VIOLATION) {
    return res.status(409).json({ message: "A template with this name or form code already exists in this organization." });
  }
  return sendSafeError(res, 500, "Failed to save template.", "Food safety template write error:", error);
}

function handleTemplateApiError(res: import("express").Response, error: unknown, logContext: string): import("express").Response {
  if (error instanceof TemplateApiError) {
    return res.status(error.status).json({ message: error.message });
  }
  return sendSafeError(res, 500, "Something went wrong.", logContext, error);
}

const templatesRouter = Router();

// A user with only food_safety:manage_templates can still read templates —
// mirrors the departments/locations canView pattern from Phase 1.
const canView = requireAnyPermission(["food_safety:view", "food_safety:manage_templates"]);
const canManage = requirePermission("food_safety:manage_templates");

// ── templates ──────────────────────────────────────────────────────────────

// GET /food-safety/templates
templatesRouter.get("/food-safety/templates", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const scope = orgScopedTable("food_safety_form_templates", organizationId);

  const [templatesResult, versionsResult] = await Promise.all([
    scope.selectAll().order("sort_order", { ascending: true }).order("name", { ascending: true }),
    orgScopedTable("food_safety_form_template_versions", organizationId).selectAll(
      "template_id, version_number, status"
    )
  ]);

  if (templatesResult.error) {
    return sendSafeError(res, 500, "Failed to load templates.", "Food safety templates list error:", templatesResult.error);
  }
  if (versionsResult.error) {
    return sendSafeError(res, 500, "Failed to load templates.", "Food safety template versions summary error:", versionsResult.error);
  }

  type VersionSummaryRow = { template_id: string; version_number: number; status: string };
  const versionsByTemplate = new Map<string, VersionSummaryRow[]>();
  for (const row of (versionsResult.data ?? []) as VersionSummaryRow[]) {
    const list = versionsByTemplate.get(row.template_id) ?? [];
    list.push(row);
    versionsByTemplate.set(row.template_id, list);
  }

  const templates = ((templatesResult.data ?? []) as FoodSafetyFormTemplateRow[]).map((template) => {
    const versions = versionsByTemplate.get(template.id) ?? [];
    const latestPublished = versions
      .filter((v) => v.status === "published")
      .sort((a, b) => b.version_number - a.version_number)[0];
    const draft = versions.find((v) => v.status === "draft");

    return {
      ...template,
      latest_published_version_number: latestPublished?.version_number ?? null,
      has_draft: Boolean(draft),
      draft_version_number: draft?.version_number ?? null
    };
  });

  return res.json(templates);
});

// GET /food-safety/templates/:id
templatesRouter.get("/food-safety/templates/:id", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;

  const scope = orgScopedTable("food_safety_form_templates", organizationId);
  const { data, error } = await scope.selectById(id);

  if (error) {
    return sendSafeError(res, 500, "Failed to load template.", "Food safety template fetch error:", error);
  }
  if (!data) {
    return res.status(404).json({ message: "Template not found" });
  }

  return res.json(data);
});

// POST /food-safety/templates
templatesRouter.post("/food-safety/templates", canManage, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: TemplatePayload;

  try {
    payload = await validateTemplatePayload(req.body, organizationId);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const scope = orgScopedTable("food_safety_form_templates", organizationId);
  const { data, error } = await scope.insert(payload);

  if (error) {
    return handleTemplateWriteError(res, error);
  }

  return res.status(201).json(data);
});

// PUT /food-safety/templates/:id — metadata only; never touches version content.
templatesRouter.put("/food-safety/templates/:id", canManage, async (req, res) => {
  const organizationId = req.organizationId;
  const id = req.params.id as string;
  let payload: TemplatePayload;

  try {
    payload = await validateTemplatePayload(req.body, organizationId);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const scope = orgScopedTable("food_safety_form_templates", organizationId);
  const { data, error } = await scope.update(id, payload);

  if (error) {
    return handleTemplateWriteError(res, error);
  }
  if (!data) {
    return res.status(404).json({ message: "Template not found" });
  }

  return res.json(data);
});

// ── versions ───────────────────────────────────────────────────────────────

// GET /food-safety/templates/:id/versions
templatesRouter.get("/food-safety/templates/:id/versions", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const templateId = req.params.id as string;

  try {
    await ensureTemplateExists(organizationId, templateId);
    const versions = await listVersionSummaries(organizationId, templateId);

    const canSeeDrafts = await userHasPermission(req, "food_safety:manage_templates");
    const visible = canSeeDrafts ? versions : versions.filter((v) => v.status === "published");

    return res.json(visible);
  } catch (error) {
    return handleTemplateApiError(res, error, "Food safety versions list error:");
  }
});

// GET /food-safety/templates/:id/versions/:versionId
templatesRouter.get("/food-safety/templates/:id/versions/:versionId", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const templateId = req.params.id as string;
  const versionId = req.params.versionId as string;

  try {
    await ensureTemplateExists(organizationId, templateId);
    const version = await getVersionRow(organizationId, templateId, versionId);
    if (!version) {
      return res.status(404).json({ message: "Version not found" });
    }

    if (version.status !== "published") {
      const canSeeDrafts = await userHasPermission(req, "food_safety:manage_templates");
      if (!canSeeDrafts) {
        return res.status(403).json({ message: "You do not have permission to view this version." });
      }
    }

    return res.json(version);
  } catch (error) {
    return handleTemplateApiError(res, error, "Food safety version fetch error:");
  }
});

// POST /food-safety/templates/:id/versions — creates the FIRST version only.
// Subsequent versions are created via clone (see below).
templatesRouter.post("/food-safety/templates/:id/versions", canManage, async (req, res) => {
  const organizationId = req.organizationId;
  const templateId = req.params.id as string;
  const body = (req.body ?? {}) as { schema_json?: unknown; version_notes?: unknown };

  const versionNotes = typeof body.version_notes === "string" ? body.version_notes : null;

  try {
    await ensureTemplateExists(organizationId, templateId);
    const version = await createFirstVersion(
      organizationId,
      templateId,
      body.schema_json,
      versionNotes,
      req.userId ?? null
    );
    return res.status(201).json(version);
  } catch (error) {
    return handleTemplateApiError(res, error, "Food safety version create error:");
  }
});

// PUT /food-safety/templates/:id/versions/:versionId — edit a draft only.
templatesRouter.put("/food-safety/templates/:id/versions/:versionId", canManage, async (req, res) => {
  const organizationId = req.organizationId;
  const templateId = req.params.id as string;
  const versionId = req.params.versionId as string;
  const body = (req.body ?? {}) as { schema_json?: unknown; version_notes?: unknown };

  const versionNotes = body.version_notes === undefined ? undefined : typeof body.version_notes === "string" ? body.version_notes : null;

  try {
    await ensureTemplateExists(organizationId, templateId);
    const version = await updateDraftVersion(organizationId, templateId, versionId, body.schema_json, versionNotes);
    return res.json(version);
  } catch (error) {
    return handleTemplateApiError(res, error, "Food safety version update error:");
  }
});

// POST /food-safety/templates/:id/versions/:versionId/publish
templatesRouter.post("/food-safety/templates/:id/versions/:versionId/publish", canManage, async (req, res) => {
  const organizationId = req.organizationId;
  const templateId = req.params.id as string;
  const versionId = req.params.versionId as string;

  try {
    await ensureTemplateExists(organizationId, templateId);
    const version = await publishVersion(organizationId, templateId, versionId, req.userId ?? null);
    return res.json(version);
  } catch (error) {
    return handleTemplateApiError(res, error, "Food safety version publish error:");
  }
});

// POST /food-safety/templates/:id/versions/:versionId/clone — creates the
// next draft version, copying the source version's schema_json verbatim.
templatesRouter.post("/food-safety/templates/:id/versions/:versionId/clone", canManage, async (req, res) => {
  const organizationId = req.organizationId;
  const templateId = req.params.id as string;
  const versionId = req.params.versionId as string;

  try {
    await ensureTemplateExists(organizationId, templateId);
    const version = await cloneVersion(organizationId, templateId, versionId, req.userId ?? null);
    return res.status(201).json(version);
  } catch (error) {
    return handleTemplateApiError(res, error, "Food safety version clone error:");
  }
});

export { templatesRouter };
