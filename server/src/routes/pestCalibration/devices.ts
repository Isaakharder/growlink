import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";
import { computeDueStatus } from "./services/dueScheduling";
import {
  CUSTOM_INTERVAL_UNITS, FIELD_TYPES, FREQUENCY_TYPES,
  CustomIntervalUnit, FieldType, FrequencyType, Task, TemplateField
} from "./services/types";

const devicesRouter = Router();

const canView = requireAnyPermission(["calibration:view", "calibration:edit", "mobile:calibration"]);
const canEdit = requirePermission("calibration:edit");

type DevicePayload = {
  name: string;
  area: string | null;
  identification_number: string | null;
  frequency_type: FrequencyType;
  custom_interval_value: number | null;
  custom_interval_unit: CustomIntervalUnit | null;
  notes: string | null;
  instructions: string | null;
};

// is_active is deliberately absent from this payload — it's a list-view
// action (archive/reactivate), never a form field, matching Food Safety's
// Deactivate button (never part of the location Add/Edit form).
function validateDevicePayload(input: unknown): DevicePayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }
  const body = input as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new Error("Device name is required.");

  const frequency_type = typeof body.frequency_type === "string" ? body.frequency_type : "";
  if (!FREQUENCY_TYPES.includes(frequency_type as FrequencyType)) {
    throw new Error("A valid calibration frequency is required.");
  }

  let custom_interval_value: number | null = null;
  let custom_interval_unit: CustomIntervalUnit | null = null;
  if (frequency_type === "custom") {
    const rawValue = body.custom_interval_value;
    custom_interval_value = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(custom_interval_value) || custom_interval_value <= 0) {
      throw new Error("Custom interval requires a value greater than 0.");
    }
    const rawUnit = typeof body.custom_interval_unit === "string" ? body.custom_interval_unit : "";
    if (!CUSTOM_INTERVAL_UNITS.includes(rawUnit as CustomIntervalUnit)) {
      throw new Error("Custom interval requires a unit of days, weeks, or months.");
    }
    custom_interval_unit = rawUnit as CustomIntervalUnit;
  }

  return {
    name,
    area: typeof body.area === "string" ? body.area.trim() || null : null,
    identification_number: typeof body.identification_number === "string" ? body.identification_number.trim() || null : null,
    frequency_type: frequency_type as FrequencyType,
    custom_interval_value,
    custom_interval_unit,
    notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
    instructions: typeof body.instructions === "string" ? body.instructions.trim() || null : null
  };
}

// ── list ──────────────────────────────────────────────────────────────────

devicesRouter.get("/pest/calibration/devices", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("pest_calibration_devices")
    .select("*")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load calibration devices.", "Calibration devices fetch error:", error);
  }

  // Task count for the list-card stat line (mirrors Food Safety's "N
  // cleaning tasks"). One hop now (device -> template -> tasks), simpler
  // than the old field-counting version from before tasks existed.
  const [{ data: templates, error: templatesError }, { data: taskRows, error: tasksError }] = await Promise.all([
    supabase.from("pest_calibration_templates").select("id, device_id").eq("organization_id", organizationId),
    supabase.from("pest_calibration_tasks").select("template_id").eq("organization_id", organizationId)
  ]);

  if (templatesError) {
    return sendSafeError(res, 500, "Failed to load calibration devices.", "Calibration devices template fetch error:", templatesError);
  }
  if (tasksError) {
    return sendSafeError(res, 500, "Failed to load calibration devices.", "Calibration devices task count error:", tasksError);
  }

  const deviceIdByTemplateId = new Map((templates ?? []).map((t) => [t.id, t.device_id as string]));
  const taskCountByDeviceId = new Map<string, number>();
  for (const row of taskRows ?? []) {
    const deviceId = deviceIdByTemplateId.get(row.template_id as string);
    if (!deviceId) continue;
    taskCountByDeviceId.set(deviceId, (taskCountByDeviceId.get(deviceId) ?? 0) + 1);
  }

  const now = new Date();
  const devices = (data ?? []).map((device) => ({
    ...device,
    task_count: taskCountByDeviceId.get(device.id) ?? 0,
    due_status: computeDueStatus(device.next_due_at ? new Date(device.next_due_at) : null, now)
  }));

  return res.json(devices);
});

// ── create ────────────────────────────────────────────────────────────────

devicesRouter.post("/pest/calibration/devices", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: DevicePayload;

  try {
    payload = validateDevicePayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const { data: device, error: deviceError } = await supabase
    .from("pest_calibration_devices")
    .insert({ organization_id: organizationId, ...payload })
    .select("*")
    .single();

  if (deviceError) {
    return sendSafeError(res, 500, "Failed to create device.", "Calibration device insert error:", deviceError);
  }

  // Every device gets a template row up front (1:1) so later /template
  // saves are always an update, never a "does one exist yet" branch.
  const { error: templateError } = await supabase
    .from("pest_calibration_templates")
    .insert({ organization_id: organizationId, device_id: device.id });

  if (templateError) {
    await supabase.from("pest_calibration_devices").delete().eq("id", device.id);
    return sendSafeError(res, 500, "Failed to create calibration form for device.", "Calibration template insert error:", templateError);
  }

  return res.status(201).json(device);
});

// ── detail (device + template + tasks + fields) ──────────────────────────
// Notes/instructions are plain columns on the device row itself (mirroring
// food_safety_cleaning_locations.notes/mobile_instructions) — no separate
// instructions table to join.

async function loadDeviceDetail(organizationId: string, deviceId: string) {
  const { data: device, error: deviceError } = await supabase
    .from("pest_calibration_devices")
    .select("*")
    .eq("id", deviceId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (deviceError) throw deviceError;
  if (!device) return null;

  const { data: template, error: templateError } = await supabase
    .from("pest_calibration_templates")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();

  if (templateError) throw templateError;

  let tasks: Task[] = [];
  let fields: TemplateField[] = [];
  if (template) {
    const { data: taskRows, error: tasksError } = await supabase
      .from("pest_calibration_tasks")
      .select("*")
      .eq("template_id", template.id)
      .order("sort_order", { ascending: true });
    if (tasksError) throw tasksError;
    tasks = (taskRows ?? []) as Task[];

    if (tasks.length > 0) {
      const { data: fieldRows, error: fieldsError } = await supabase
        .from("pest_calibration_template_fields")
        .select("*")
        .in("task_id", tasks.map((t) => t.id))
        .order("sort_order", { ascending: true });
      if (fieldsError) throw fieldsError;
      fields = (fieldRows ?? []) as TemplateField[];
    }
  }

  return { device, template: template ?? null, tasks, fields };
}

devicesRouter.get("/pest/calibration/devices/:id", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  try {
    const detail = await loadDeviceDetail(organizationId, id);
    if (!detail) return res.status(404).json({ message: "Device not found." });
    return res.json(detail);
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load device.", "Calibration device detail error:", error);
  }
});

devicesRouter.get("/pest/calibration/devices/:id/start", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  try {
    const detail = await loadDeviceDetail(organizationId, id);
    if (!detail) return res.status(404).json({ message: "Device not found." });
    if (!detail.device.is_active) {
      return res.status(400).json({ message: "This device is archived and cannot be calibrated." });
    }
    if (detail.tasks.length === 0) {
      return res.status(400).json({ message: "This device has no calibration form configured yet." });
    }
    return res.json({ ...detail, server_now: new Date().toISOString() });
  } catch (error) {
    return sendSafeError(res, 500, "Failed to load calibration form.", "Calibration start error:", error);
  }
});

// ── update core device fields ────────────────────────────────────────────

devicesRouter.put("/pest/calibration/devices/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);
  let payload: DevicePayload;

  try {
    payload = validateDevicePayload(req.body);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid request body" });
  }

  const { data: device, error } = await supabase
    .from("pest_calibration_devices")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to update device.", "Calibration device update error:", error);
  }
  if (!device) return res.status(404).json({ message: "Device not found." });

  return res.json(device);
});

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter((v) => v.length > 0);
  return items.length > 0 ? items : null;
}

// ── archive / reactivate ─────────────────────────────────────────────────
// List-view actions, matching Food Safety's Deactivate button — never form
// fields. Unlike Food Safety (one-way deactivate), Calibration devices can
// be reactivated: an archived device's calibration history must stay fully
// intact and searchable either way (records reference device_id with
// on delete set null and fully snapshot device fields, so archiving never
// touches history), and it must disappear from the mobile device list /
// "available for a new calibration" set — enforced here (list still shows
// it for desktop visibility) and again in /start and /complete, which both
// already reject an inactive device outright.

devicesRouter.post("/pest/calibration/devices/:id/archive", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  const { data: device, error } = await supabase
    .from("pest_calibration_devices")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to archive device.", "Calibration device archive error:", error);
  }
  if (!device) return res.status(404).json({ message: "Device not found." });

  return res.status(204).send();
});

devicesRouter.post("/pest/calibration/devices/:id/reactivate", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  const { data: device, error } = await supabase
    .from("pest_calibration_devices")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to reactivate device.", "Calibration device reactivate error:", error);
  }
  if (!device) return res.status(404).json({ message: "Device not found." });

  return res.status(204).send();
});

// ── template: tasks + response fields (two-level diff-based upsert) ─────

type IncomingFieldPayload = {
  id?: string | null;
  client_key?: string;
  field_type: FieldType;
  label: string;
  help_text?: string | null;
  is_required?: boolean;
  placeholder?: string | null;
  unit?: string | null;
  min_value?: number | null;
  max_value?: number | null;
  decimal_precision?: number | null;
  choice_options?: string[] | null;
  sort_order: number;
};

type IncomingTaskPayload = {
  id?: string | null;
  client_key?: string;
  name: string;
  sort_order: number;
  is_repeating: boolean;
  min_rows: number | null;
  max_rows: number | null;
  fields: IncomingFieldPayload[];
};

function validateFieldPayload(raw: unknown, taskLabel: string, index: number): IncomingFieldPayload {
  if (!raw || typeof raw !== "object") throw new Error(`A field in "${taskLabel}" is invalid.`);
  const f = raw as Record<string, unknown>;

  const field_type = typeof f.field_type === "string" ? f.field_type : "";
  if (!FIELD_TYPES.includes(field_type as FieldType)) {
    throw new Error(`A field in "${taskLabel}" has an invalid response type.`);
  }
  const label = typeof f.label === "string" ? f.label.trim() : "";
  if (!label) throw new Error(`A field in "${taskLabel}" needs a label.`);

  const id = typeof f.id === "string" ? f.id : null;
  if (!id && typeof f.client_key !== "string") {
    throw new Error(`"${label}" is new and needs a client_key.`);
  }

  let choice_options = toStringArray(f.choice_options);

  // checkbox: at least one checkable label is required — an employee-facing
  // checkbox field with nothing to check is meaningless, matching Food
  // Safety's own "needs at least one checkbox label" rule.
  if (field_type === "checkbox" && (!choice_options || choice_options.length === 0)) {
    throw new Error(`"${label}" needs at least one checkbox.`);
  }

  // pass_fail: exactly 2 labels — default to ["Pass", "Fail"] so an admin
  // never has to configure anything to get the ordinary case, but can
  // rename either label (e.g. "Within tolerance" / "Out of tolerance").
  // The underlying stored value stays a plain boolean either way — only
  // the displayed labels are customizable.
  if (field_type === "pass_fail") {
    if (!choice_options || choice_options.length === 0) {
      choice_options = ["Pass", "Fail"];
    } else if (choice_options.length !== 2) {
      throw new Error(`"${label}" needs exactly two labels (pass and fail).`);
    }
  }

  return {
    id,
    client_key: typeof f.client_key === "string" ? f.client_key : undefined,
    field_type: field_type as FieldType,
    label,
    help_text: typeof f.help_text === "string" ? f.help_text.trim() || null : null,
    is_required: typeof f.is_required === "boolean" ? f.is_required : false,
    placeholder: typeof f.placeholder === "string" ? f.placeholder.trim() || null : null,
    unit: typeof f.unit === "string" ? f.unit.trim() || null : null,
    min_value: typeof f.min_value === "number" ? f.min_value : null,
    max_value: typeof f.max_value === "number" ? f.max_value : null,
    decimal_precision: typeof f.decimal_precision === "number" ? f.decimal_precision : null,
    choice_options,
    sort_order: typeof f.sort_order === "number" ? f.sort_order : index
  };
}

function validateTaskPayload(raw: unknown, index: number): IncomingTaskPayload {
  if (!raw || typeof raw !== "object") throw new Error(`Task ${index + 1} is invalid.`);
  const t = raw as Record<string, unknown>;

  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!name) throw new Error(`Task ${index + 1} needs a name.`);

  const id = typeof t.id === "string" ? t.id : null;
  if (!id && typeof t.client_key !== "string") {
    throw new Error(`"${name}" is new and needs a client_key.`);
  }

  const is_repeating = typeof t.is_repeating === "boolean" ? t.is_repeating : false;
  const min_rows = is_repeating && typeof t.min_rows === "number" ? t.min_rows : null;
  const max_rows = is_repeating && typeof t.max_rows === "number" ? t.max_rows : null;

  if (!Array.isArray(t.fields) || t.fields.length === 0) {
    throw new Error(`"${name}" needs at least one response field.`);
  }
  const fields = t.fields.map((f, fieldIndex) => validateFieldPayload(f, name, fieldIndex));

  return {
    id,
    client_key: typeof t.client_key === "string" ? t.client_key : undefined,
    name,
    sort_order: typeof t.sort_order === "number" ? t.sort_order : index,
    is_repeating,
    min_rows,
    max_rows,
    fields
  };
}

devicesRouter.put("/pest/calibration/devices/:id/template", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const deviceId = String(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  let tasksInput: IncomingTaskPayload[];
  try {
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) throw new Error("At least one task is required.");
    tasksInput = body.tasks.map((t, index) => validateTaskPayload(t, index));
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid task configuration." });
  }

  let template: { id: string } | null;
  {
    const { data, error: templateLookupError } = await supabase
      .from("pest_calibration_templates")
      .select("id")
      .eq("device_id", deviceId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (templateLookupError) {
      return sendSafeError(res, 500, "Failed to load calibration form.", "Calibration template lookup error:", templateLookupError);
    }
    template = data;
  }

  if (!template) {
    // A missing template doesn't necessarily mean a missing device — every
    // device is supposed to get a template row up front (see the POST
    // handler above), but a schema reset can leave older devices without
    // one. Confirm the device itself exists in this org, then transparently
    // create the template it should already have, rather than 404ing on a
    // device that's actually fine.
    const { data: device, error: deviceError } = await supabase
      .from("pest_calibration_devices")
      .select("id")
      .eq("id", deviceId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (deviceError) {
      return sendSafeError(res, 500, "Failed to load device.", "Calibration device lookup error:", deviceError);
    }
    if (!device) return res.status(404).json({ message: "Device not found." });

    const { data: newTemplate, error: createTemplateError } = await supabase
      .from("pest_calibration_templates")
      .insert({ organization_id: organizationId, device_id: deviceId })
      .select("id")
      .single();
    if (createTemplateError) {
      return sendSafeError(res, 500, "Failed to create calibration form for device.", "Calibration template create error:", createTemplateError);
    }
    template = newTemplate;
  }

  // ── Step 1: diff tasks ──
  const { data: existingTaskRows, error: existingTasksError } = await supabase
    .from("pest_calibration_tasks")
    .select("id")
    .eq("template_id", template.id);

  if (existingTasksError) {
    return sendSafeError(res, 500, "Failed to load existing tasks.", "Calibration existing tasks error:", existingTasksError);
  }

  const existingTaskIds = new Set((existingTaskRows ?? []).map((t) => t.id as string));
  const incomingTaskIds = new Set(tasksInput.filter((t) => t.id).map((t) => t.id as string));
  const taskIdsToDelete = [...existingTaskIds].filter((id) => !incomingTaskIds.has(id));

  // Deleting a task cascades its fields automatically (fields.task_id ON
  // DELETE CASCADE) — no separate field cleanup needed for removed tasks.
  if (taskIdsToDelete.length > 0) {
    const { error: deleteTasksError } = await supabase
      .from("pest_calibration_tasks")
      .delete()
      .eq("template_id", template.id)
      .in("id", taskIdsToDelete);
    if (deleteTasksError) {
      return sendSafeError(res, 500, "Failed to remove tasks.", "Calibration task delete error:", deleteTasksError);
    }
  }

  const existingTaskUpdates = tasksInput.filter((t) => t.id);
  for (const t of existingTaskUpdates) {
    const { error: updateTaskError } = await supabase
      .from("pest_calibration_tasks")
      .update({
        name: t.name, sort_order: t.sort_order, is_repeating: t.is_repeating,
        min_rows: t.min_rows, max_rows: t.max_rows, updated_at: new Date().toISOString()
      })
      .eq("id", t.id as string)
      .eq("template_id", template.id);
    if (updateTaskError) {
      return sendSafeError(res, 500, `Failed to update "${t.name}".`, "Calibration task update error:", updateTaskError);
    }
  }

  const newTasks = tasksInput.filter((t) => !t.id);
  const taskClientKeyToId = new Map<string, string>();
  if (newTasks.length > 0) {
    const { data: insertedTasks, error: insertTasksError } = await supabase
      .from("pest_calibration_tasks")
      .insert(newTasks.map((t) => ({
        organization_id: organizationId, template_id: template.id, name: t.name, sort_order: t.sort_order,
        is_repeating: t.is_repeating, min_rows: t.min_rows, max_rows: t.max_rows
      })))
      .select("id");
    if (insertTasksError) {
      return sendSafeError(res, 500, "Failed to add new tasks.", "Calibration task insert error:", insertTasksError);
    }
    // Insert preserves array order — safe to zip by index.
    (insertedTasks ?? []).forEach((row, index) => {
      if (newTasks[index].client_key) taskClientKeyToId.set(newTasks[index].client_key as string, row.id);
    });
  }

  function resolveTaskId(t: IncomingTaskPayload): string {
    const resolved = t.id ?? (t.client_key ? taskClientKeyToId.get(t.client_key) : undefined);
    if (!resolved) throw new Error(`Could not resolve id for task "${t.name}".`);
    return resolved;
  }

  // ── Step 2: diff fields (scoped within each task) ──
  let existingFieldIds = new Set<string>();
  if (existingTaskIds.size > 0) {
    const { data: existingFieldRows, error: existingFieldsError } = await supabase
      .from("pest_calibration_template_fields")
      .select("id")
      .in("task_id", [...existingTaskIds]);
    if (existingFieldsError) {
      return sendSafeError(res, 500, "Failed to load existing fields.", "Calibration existing fields error:", existingFieldsError);
    }
    existingFieldIds = new Set((existingFieldRows ?? []).map((f) => f.id as string));
  }

  const incomingFieldIds = new Set(tasksInput.flatMap((t) => t.fields).filter((f) => f.id).map((f) => f.id as string));
  const fieldIdsToDelete = [...existingFieldIds].filter((id) => !incomingFieldIds.has(id));

  if (fieldIdsToDelete.length > 0) {
    const { error: deleteFieldsError } = await supabase
      .from("pest_calibration_template_fields")
      .delete()
      .eq("organization_id", organizationId)
      .in("id", fieldIdsToDelete);
    if (deleteFieldsError) {
      return sendSafeError(res, 500, "Failed to remove fields.", "Calibration field delete error:", deleteFieldsError);
    }
  }

  try {
    for (const t of tasksInput) {
      const realTaskId = resolveTaskId(t);
      for (const f of t.fields.filter((f) => f.id)) {
        const { error: updateFieldError } = await supabase
          .from("pest_calibration_template_fields")
          .update({
            label: f.label, help_text: f.help_text, is_required: f.is_required, placeholder: f.placeholder, unit: f.unit,
            min_value: f.min_value, max_value: f.max_value, decimal_precision: f.decimal_precision,
            choice_options: f.choice_options, sort_order: f.sort_order, updated_at: new Date().toISOString()
          })
          .eq("id", f.id as string)
          .eq("task_id", realTaskId);
        if (updateFieldError) throw updateFieldError;
      }
    }
  } catch (error) {
    return sendSafeError(res, 500, "Failed to update fields.", "Calibration field update error:", error);
  }

  const newFieldRows: { client_key?: string; row: Record<string, unknown> }[] = [];
  for (const t of tasksInput) {
    const realTaskId = resolveTaskId(t);
    for (const f of t.fields.filter((f) => !f.id)) {
      newFieldRows.push({
        client_key: f.client_key,
        row: {
          organization_id: organizationId, task_id: realTaskId, field_type: f.field_type,
          label: f.label, help_text: f.help_text, is_required: f.is_required, placeholder: f.placeholder, unit: f.unit,
          min_value: f.min_value, max_value: f.max_value, decimal_precision: f.decimal_precision,
          choice_options: f.choice_options, sort_order: f.sort_order
        }
      });
    }
  }

  const fieldClientKeyToId = new Map<string, string>();
  if (newFieldRows.length > 0) {
    const { data: insertedFields, error: insertFieldsError } = await supabase
      .from("pest_calibration_template_fields")
      .insert(newFieldRows.map((r) => r.row))
      .select("id");
    if (insertFieldsError) {
      return sendSafeError(res, 500, "Failed to add new fields.", "Calibration field insert error:", insertFieldsError);
    }
    (insertedFields ?? []).forEach((row, index) => {
      if (newFieldRows[index].client_key) fieldClientKeyToId.set(newFieldRows[index].client_key as string, row.id);
    });
  }

  const { error: templateUpdateError } = await supabase
    .from("pest_calibration_templates")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", template.id);

  if (templateUpdateError) {
    return sendSafeError(res, 500, "Failed to save calibration form settings.", "Calibration template update error:", templateUpdateError);
  }

  try {
    const detail = await loadDeviceDetail(organizationId, deviceId);
    return res.json(detail);
  } catch (error) {
    return sendSafeError(res, 500, "Form saved, but failed to reload it.", "Calibration template reload error:", error);
  }
});

export { devicesRouter, loadDeviceDetail, validateDevicePayload };
