import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError, isUniqueViolation } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";

type CleaningLocationFrequency = "daily" | "weekly" | "monthly" | "annually";
type CleaningTaskResponseType = "checkbox" | "number" | "short_text" | "long_text";

const FREQUENCY_VALUES: CleaningLocationFrequency[] = ["daily", "weekly", "monthly", "annually"];
const RESPONSE_TYPE_VALUES: CleaningTaskResponseType[] = ["checkbox", "number", "short_text", "long_text"];
const MAX_NOTES_LENGTH = 2000;

type CleaningTaskPayload = {
  name: string;
  responseType: CleaningTaskResponseType;
  actionLabels: string[] | null;
};

type CleaningLocationPayload = {
  name: string;
  area: string;
  frequency: CleaningLocationFrequency;
  notes: string | null;
  tasks: CleaningTaskPayload[];
};

function validatePayload(input: unknown): CleaningLocationPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const area = typeof body.area === "string" ? body.area.trim() : "";
  const frequency = typeof body.frequency === "string" ? body.frequency.toLowerCase() : "";

  if (!name) {
    throw new Error("Location name is required");
  }

  if (!area) {
    throw new Error("Area/building is required");
  }

  if (!FREQUENCY_VALUES.includes(frequency as CleaningLocationFrequency)) {
    throw new Error("A valid frequency is required");
  }

  const rawNotes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (rawNotes.length > MAX_NOTES_LENGTH) {
    throw new Error(`Notes cannot exceed ${MAX_NOTES_LENGTH} characters`);
  }
  const notes = rawNotes.length > 0 ? rawNotes : null;

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    throw new Error("At least one cleaning task is required");
  }

  const tasks: CleaningTaskPayload[] = body.tasks.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Task ${index + 1} is invalid`);
    }

    const taskBody = raw as Record<string, unknown>;
    const taskName = typeof taskBody.name === "string" ? taskBody.name.trim() : "";
    const responseType = typeof taskBody.responseType === "string" ? taskBody.responseType.toLowerCase() : "checkbox";
    const rawLabels = Array.isArray(taskBody.actionLabels) ? taskBody.actionLabels : [];
    const actionLabels = rawLabels
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);

    if (!taskName) {
      throw new Error(`Task ${index + 1} needs a name`);
    }

    if (!RESPONSE_TYPE_VALUES.includes(responseType as CleaningTaskResponseType)) {
      throw new Error(`Task ${index + 1} needs a valid response type`);
    }

    if (responseType === "checkbox" && actionLabels.length === 0) {
      throw new Error(`Task ${index + 1} needs at least one checkbox label`);
    }

    return {
      name: taskName,
      responseType: responseType as CleaningTaskResponseType,
      actionLabels: responseType === "checkbox" ? actionLabels : null
    };
  });

  return { name, area, frequency: frequency as CleaningLocationFrequency, notes, tasks };
}

const cleaningLocationsRouter = Router();

const canView = requireAnyPermission(["food_safety:view", "food_safety:edit"]);
const canEdit = requirePermission("food_safety:edit");

cleaningLocationsRouter.get("/food-safety/cleaning-locations", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("food_safety_cleaning_locations")
    .select("*, food_safety_cleaning_tasks(*)")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load cleaning locations.", "Cleaning locations fetch error:", error);
  }

  const locations = (data ?? []).map((row) => {
    const { food_safety_cleaning_tasks, ...location } = row as typeof row & {
      food_safety_cleaning_tasks: { id: string; name: string; sort_order: number }[];
    };

    return {
      ...location,
      tasks: [...food_safety_cleaning_tasks].sort((a, b) => a.sort_order - b.sort_order)
    };
  });

  return res.json(locations);
});

cleaningLocationsRouter.post("/food-safety/cleaning-locations", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: CleaningLocationPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data: location, error: locationError } = await supabase
    .from("food_safety_cleaning_locations")
    .insert({
      organization_id: organizationId,
      name: payload.name,
      area: payload.area,
      frequency: payload.frequency,
      notes: payload.notes,
      created_by: req.userId ?? null
    })
    .select("*")
    .single();

  if (locationError) {
    if (isUniqueViolation(locationError)) {
      return res.status(409).json({ message: `A location named "${payload.name}" already exists.` });
    }
    return sendSafeError(res, 500, "Failed to create location.", "Cleaning location insert error:", locationError);
  }

  const { data: tasks, error: tasksError } = await supabase
    .from("food_safety_cleaning_tasks")
    .insert(
      payload.tasks.map((task, index) => ({
        organization_id: organizationId,
        location_id: location.id,
        name: task.name,
        response_type: task.responseType,
        action_labels: task.actionLabels,
        sort_order: index
      }))
    )
    .select("*");

  if (tasksError) {
    // Roll back the just-created location so we never leave a task-less row behind.
    await supabase.from("food_safety_cleaning_locations").delete().eq("id", location.id);
    return sendSafeError(res, 500, "Failed to create cleaning tasks.", "Cleaning tasks insert error:", tasksError);
  }

  return res.status(201).json({ ...location, tasks: tasks ?? [] });
});

cleaningLocationsRouter.put("/food-safety/cleaning-locations/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: CleaningLocationPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data: location, error: locationError } = await supabase
    .from("food_safety_cleaning_locations")
    .update({
      name: payload.name,
      area: payload.area,
      frequency: payload.frequency,
      notes: payload.notes,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();

  if (locationError) {
    if (isUniqueViolation(locationError)) {
      return res.status(409).json({ message: `A location named "${payload.name}" already exists.` });
    }
    return sendSafeError(res, 500, "Failed to update location.", "Cleaning location update error:", locationError);
  }

  if (!location) {
    return res.status(404).json({ message: "Location not found." });
  }

  // Insert the new task set BEFORE deleting the old one — if the insert
  // fails (transient DB error, etc.), the location keeps its previous,
  // still-valid tasks instead of being left with zero tasks and a broken
  // mobile checklist until someone notices and re-edits it. The two sets
  // can briefly coexist (no uniqueness constraint on task name/location
  // forbids it), so this reordering carries no correctness cost.
  const { data: tasks, error: tasksError } = await supabase
    .from("food_safety_cleaning_tasks")
    .insert(
      payload.tasks.map((task, index) => ({
        organization_id: organizationId,
        location_id: id,
        name: task.name,
        response_type: task.responseType,
        action_labels: task.actionLabels,
        sort_order: index
      }))
    )
    .select("*");

  if (tasksError) {
    return sendSafeError(res, 500, "Failed to update cleaning tasks.", "Cleaning tasks insert error:", tasksError);
  }

  const newTaskIds = (tasks ?? []).map((t) => t.id);
  const { error: deleteTasksError } = await supabase
    .from("food_safety_cleaning_tasks")
    .delete()
    .eq("location_id", id)
    .eq("organization_id", organizationId)
    .not("id", "in", `(${newTaskIds.join(",")})`);

  if (deleteTasksError) {
    // The new tasks are already live; the old ones just failed to clean up.
    // Not the total-data-loss failure mode this reordering exists to avoid,
    // but still worth surfacing so an admin knows to retry the edit.
    return sendSafeError(
      res,
      500,
      "Cleaning tasks were updated, but removing the previous task set failed. Please try saving again.",
      "Cleaning tasks old-set delete error:",
      deleteTasksError
    );
  }

  return res.json({ ...location, tasks: tasks ?? [] });
});

// "Delete" is a soft delete: the location is deactivated, never dropped.
// Its tasks, checklists, and — most importantly — its historical reports
// (immutable, and still shown in Reports per reports.ts) all stay intact.
// Deactivating an already-inactive (or nonexistent) location is treated as
// not-found, matching the "nothing left to delete" semantics of a real
// DELETE against something that's already gone.
cleaningLocationsRouter.delete("/food-safety/cleaning-locations/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { data: location, error } = await supabase
    .from("food_safety_cleaning_locations")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .select("id")
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to deactivate location.", "Cleaning location deactivate error:", error);
  }

  if (!location) {
    return res.status(404).json({ message: "Location not found." });
  }

  return res.status(204).send();
});

export { cleaningLocationsRouter };
