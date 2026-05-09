import { Router } from "express";
import { supabase } from "../config/supabase";

type VarietyStatus = "active" | "inactive";
type VarietyColor = "red" | "orange" | "yellow" | "green";

type VarietyPayload = {
  name: string;
  area_m2: number;
  case_kg: number;
  planting_date: string | null;
  pull_out_date: string | null;
  status: VarietyStatus;
  color: VarietyColor;
};

const STATUS_VALUES: VarietyStatus[] = ["active", "inactive"];
const COLOR_VALUES: VarietyColor[] = ["red", "orange", "yellow", "green"];

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseNonNegativeNumber(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }

  return parsed;
}

function validatePayload(input: unknown): VarietyPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    throw new Error("name is required");
  }

  const area_m2 = parseNonNegativeNumber(body.area_m2, "area_m2");
  const case_kg = parseNonNegativeNumber(body.case_kg, "case_kg");

  const statusValue =
    typeof body.status === "string" ? body.status.toLowerCase() : "";

  const colorValue =
    typeof body.color === "string" ? body.color.toLowerCase() : "";

  if (!STATUS_VALUES.includes(statusValue as VarietyStatus)) {
    throw new Error("status must be active or inactive");
  }

  if (!COLOR_VALUES.includes(colorValue as VarietyColor)) {
    throw new Error("color must be red, orange, yellow, or green");
  }

  if (body.planting_date !== null && body.planting_date !== undefined) {
    if (!isValidDate(body.planting_date)) {
      throw new Error("planting_date must be in YYYY-MM-DD format");
    }
  }

  if (body.pull_out_date !== null && body.pull_out_date !== undefined) {
    if (!isValidDate(body.pull_out_date)) {
      throw new Error("pull_out_date must be in YYYY-MM-DD format");
    }
  }

  return {
    name,
    area_m2,
    case_kg,
    planting_date: (body.planting_date as string | null | undefined) ?? null,
    pull_out_date: (body.pull_out_date as string | null | undefined) ?? null,
    status: statusValue as VarietyStatus,
    color: colorValue as VarietyColor
  };
}

const varietiesRouter = Router();

varietiesRouter.get("/varieties", async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("varieties")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.json(data ?? []);
});

varietiesRouter.post("/varieties", async (req, res) => {
  const organizationId = req.organizationId;
  let payload: VarietyPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("varieties")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.status(201).json(data);
});

varietiesRouter.put("/varieties/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: VarietyPayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("varieties")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.json(data);
});

varietiesRouter.delete("/varieties/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("varieties")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.status(204).send();
});

export { varietiesRouter };
