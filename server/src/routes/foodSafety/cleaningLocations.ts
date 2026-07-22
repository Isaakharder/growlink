import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";

type CleaningTaskFrequency = "daily" | "weekly" | "monthly" | "annually";
type CleaningTaskResponseType = "checkbox" | "number" | "short_text" | "long_text";

const FREQUENCY_VALUES: CleaningTaskFrequency[] = ["daily", "weekly", "monthly", "annually"];
const RESPONSE_TYPE_VALUES: CleaningTaskResponseType[] = ["checkbox", "number", "short_text", "long_text"];

type CleaningTaskPayload = {
  name: string;
  frequency: CleaningTaskFrequency;
  responseType: CleaningTaskResponseType;
  actionLabel: string | null;
};

type CleaningLocationPayload = {
  name: string;
  area: string;
  tasks: CleaningTaskPayload[];
};

function validatePayload(input: unknown): CleaningLocationPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const area = typeof body.area === "string" ? body.area.trim() : "";

  if (!name) {
    throw new Error("Location name is required");
  }

  if (!area) {
    throw new Error("Area/building is required");
  }

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    throw new Error("At least one cleaning task is required");
  }

  const tasks: CleaningTaskPayload[] = body.tasks.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Task ${index + 1} is invalid`);
    }

    const taskBody = raw as Record<string, unknown>;
    const taskName = typeof taskBody.name === "string" ? taskBody.name.trim() : "";
    const frequency = typeof taskBody.frequency === "string" ? taskBody.frequency.toLowerCase() : "";
    const responseType = typeof taskBody.responseType === "string" ? taskBody.responseType.toLowerCase() : "checkbox";
    const actionLabel = typeof taskBody.actionLabel === "string" ? taskBody.actionLabel.trim() : "";

    if (!taskName) {
      throw new Error(`Task ${index + 1} needs a name`);
    }

    if (!FREQUENCY_VALUES.includes(frequency as CleaningTaskFrequency)) {
      throw new Error(`Task ${index + 1} needs a valid frequency`);
    }

    if (!RESPONSE_TYPE_VALUES.includes(responseType as CleaningTaskResponseType)) {
      throw new Error(`Task ${index + 1} needs a valid response type`);
    }

    if (responseType === "checkbox" && !actionLabel) {
      throw new Error(`Task ${index + 1} needs a checkbox label`);
    }

    return {
      name: taskName,
      frequency: frequency as CleaningTaskFrequency,
      responseType: responseType as CleaningTaskResponseType,
      actionLabel: responseType === "checkbox" ? actionLabel : null
    };
  });

  return { name, area, tasks };
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
      food_safety_cleaning_tasks: { id: string; name: string; frequency: string; sort_order: number }[];
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
      created_by: req.userId ?? null
    })
    .select("*")
    .single();

  if (locationError) {
    return sendSafeError(res, 500, "Failed to create location.", "Cleaning location insert error:", locationError);
  }

  const { data: tasks, error: tasksError } = await supabase
    .from("food_safety_cleaning_tasks")
    .insert(
      payload.tasks.map((task, index) => ({
        organization_id: organizationId,
        location_id: location.id,
        name: task.name,
        frequency: task.frequency,
        response_type: task.responseType,
        action_label: task.actionLabel,
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
    .update({ name: payload.name, area: payload.area, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (locationError) {
    return sendSafeError(res, 500, "Failed to update location.", "Cleaning location update error:", locationError);
  }

  const { error: deleteTasksError } = await supabase
    .from("food_safety_cleaning_tasks")
    .delete()
    .eq("location_id", id)
    .eq("organization_id", organizationId);

  if (deleteTasksError) {
    return sendSafeError(res, 500, "Failed to update cleaning tasks.", "Cleaning tasks delete error:", deleteTasksError);
  }

  const { data: tasks, error: tasksError } = await supabase
    .from("food_safety_cleaning_tasks")
    .insert(
      payload.tasks.map((task, index) => ({
        organization_id: organizationId,
        location_id: id,
        name: task.name,
        frequency: task.frequency,
        response_type: task.responseType,
        action_label: task.actionLabel,
        sort_order: index
      }))
    )
    .select("*");

  if (tasksError) {
    return sendSafeError(res, 500, "Failed to update cleaning tasks.", "Cleaning tasks insert error:", tasksError);
  }

  return res.json({ ...location, tasks: tasks ?? [] });
});

cleaningLocationsRouter.delete("/food-safety/cleaning-locations/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("food_safety_cleaning_locations")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete location.", "Cleaning location delete error:", error);
  }

  return res.status(204).send();
});

export { cleaningLocationsRouter };
