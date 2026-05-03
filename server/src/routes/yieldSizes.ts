import { Router } from "express";
import { supabase } from "../config/supabase";

type YieldSizeStatus = "active" | "inactive";

type YieldSizePayload = {
  name: string;
  sort_order: number;
  status: YieldSizeStatus;
};

const STATUS_VALUES: YieldSizeStatus[] = ["active", "inactive"];

function parseNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }

  return parsed;
}

function validatePayload(input: unknown): YieldSizePayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const statusValue =
    typeof body.status === "string" ? body.status.toLowerCase() : "";

  if (!name) {
    throw new Error("name is required");
  }

  const sort_order = parseNonNegativeInteger(body.sort_order, "sort_order");

  if (!STATUS_VALUES.includes(statusValue as YieldSizeStatus)) {
    throw new Error("status must be active or inactive");
  }

  return {
    name,
    sort_order,
    status: statusValue as YieldSizeStatus
  };
}

const yieldSizesRouter = Router();

yieldSizesRouter.get("/yield-sizes", async (_req, res) => {
  const { data, error } = await supabase
    .from("yield_sizes")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.json(data ?? []);
});

yieldSizesRouter.post("/yield-sizes", async (req, res) => {
  let payload: YieldSizePayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("yield_sizes")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.status(201).json(data);
});

yieldSizesRouter.put("/yield-sizes/:id", async (req, res) => {
  const { id } = req.params;
  let payload: YieldSizePayload;

  try {
    payload = validatePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("yield_sizes")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.json(data);
});

yieldSizesRouter.delete("/yield-sizes/:id", async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from("yield_sizes").delete().eq("id", id);

  if (error) {
    return res.status(500).json({ message: error.message });
  }

  return res.status(204).send();
});

export { yieldSizesRouter };
