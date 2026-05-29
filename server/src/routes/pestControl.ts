import multer from "multer";
import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";

type SprayerPayload = {
  name: string;
  nozzle_count: number;
  nozzle_volume_l_per_min: number;
  nozzle_psi: number;
  min_speed_m_per_min: number | null;
  max_speed_m_per_min: number | null;
  speed_step_m_per_min: number | null;
  has_tank: boolean;
  tank_volume_liters: number | null;
  tank_id: string | null;
};

function parseRequiredName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new Error("name is required");
  }
  return name;
}

function parsePositiveInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be 1 or greater`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }
  return parsed;
}

function parseOptionalNonNegativeNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be 0 or greater`);
  }
  return parsed;
}

function validateSprayerPayload(input: unknown): SprayerPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;

  const min_speed = parseOptionalNonNegativeNumber(body.min_speed_m_per_min, "min_speed_m_per_min");
  const max_speed = parseOptionalNonNegativeNumber(body.max_speed_m_per_min, "max_speed_m_per_min");
  const speed_step = parseOptionalNonNegativeNumber(body.speed_step_m_per_min, "speed_step_m_per_min");

  if (min_speed !== null && max_speed !== null && min_speed >= max_speed) {
    throw new Error("min_speed_m_per_min must be less than max_speed_m_per_min");
  }
  if (speed_step !== null && speed_step === 0) {
    throw new Error("speed_step_m_per_min must be greater than 0");
  }

  const has_tank = body.has_tank === true;

  let tank_volume_liters: number | null = null;
  if (has_tank && body.tank_volume_liters != null && body.tank_volume_liters !== "") {
    const vol = typeof body.tank_volume_liters === "number" ? body.tank_volume_liters : Number(body.tank_volume_liters);
    if (!Number.isFinite(vol) || vol <= 0) {
      throw new Error("tank_volume_liters must be greater than 0");
    }
    tank_volume_liters = vol;
  }

  const tank_id = !has_tank && typeof body.tank_id === "string" && body.tank_id ? body.tank_id : null;

  return {
    name: parseRequiredName(body.name),
    nozzle_count: parsePositiveInteger(body.nozzle_count, "nozzle_count"),
    nozzle_volume_l_per_min: parseNonNegativeNumber(
      body.nozzle_volume_l_per_min,
      "nozzle_volume_l_per_min"
    ),
    nozzle_psi: parseNonNegativeNumber(body.nozzle_psi, "nozzle_psi"),
    min_speed_m_per_min: min_speed,
    max_speed_m_per_min: max_speed,
    speed_step_m_per_min: speed_step,
    has_tank,
    tank_volume_liters,
    tank_id
  };
}

// ── Snapshot sanitisers (M3) ─────────────────────────────────────────────────
// Pick only the known top-level keys from each snapshot blob so that arbitrary
// client-supplied fields are never persisted.

const CHEMICAL_SNAP_KEYS = ["id", "name", "chemical_type", "phi", "chemical_group", "rate_value", "rate_unit"] as const;
const TARGET_SNAP_KEYS = ["target_mode", "valve_ids", "valve_names", "group_ids", "group_names", "total_m2", "total_row_length_meters"] as const;
const SPRAYER_SNAP_KEYS = ["id", "name", "nozzle_count", "nozzle_volume_l_per_min", "nozzle_psi", "speed_m_per_min", "nozzles_open", "selected_psi", "flow_per_nozzle_l_per_min"] as const;
const TANK_SNAP_KEYS = ["name", "volume_liters", "is_builtin"] as const;
const CALC_SNAP_KEYS = [
  "type", "total_chemical_ml", "total_chemical_l", "rate_value", "rate_unit",
  "area_label", "total_volume_l", "spray_time_minutes", "spray_time_hours",
  "total_flow_l_per_min", "tank_volume_l", "tank_count", "chem_per_liter_ml",
  "chem_per_full_tank_ml", "final_tank_volume_l", "chem_for_final_tank_ml", "is_last_full"
] as const;

function pickSnapshotKeys<K extends string>(raw: unknown, keys: readonly K[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in obj) result[k] = obj[k];
  }
  return result;
}

// ── Progress snapshot validator (M4) ─────────────────────────────────────────

function validateProgressSnapshot(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("progress_snapshot must be an object");
  }
  const snap = raw as Record<string, unknown>;

  // Valve-drench shape
  if (snap.type === "valve_drench") {
    if (!Array.isArray(snap.valves)) throw new Error("progress_snapshot.valves must be an array");
    for (const valve of snap.valves) {
      if (!valve || typeof valve !== "object" || Array.isArray(valve)) throw new Error("Each valve must be an object");
      const v = valve as Record<string, unknown>;
      if (typeof v.valveId !== "string" || !v.valveId) throw new Error("valve.valveId must be a non-empty string");
      if (typeof v.valveName !== "string") throw new Error("valve.valveName must be a string");
      if (typeof v.areaM2 !== "number") throw new Error("valve.areaM2 must be a number");
      if (typeof v.productAmount !== "number") throw new Error("valve.productAmount must be a number");
      if (typeof v.productUnit !== "string" || !v.productUnit) throw new Error("valve.productUnit must be a non-empty string");
      if (typeof v.completed !== "boolean") throw new Error("valve.completed must be a boolean");
      if (v.completedAt !== null && typeof v.completedAt !== "string") throw new Error("valve.completedAt must be a string or null");
    }
    return { type: "valve_drench", valves: snap.valves };
  }

  // Phase-based shape
  if (!Array.isArray(snap.phases)) {
    throw new Error("progress_snapshot.phases must be an array");
  }
  for (const phase of snap.phases) {
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
      throw new Error("Each phase must be an object");
    }
    const p = phase as Record<string, unknown>;
    if (typeof p.phaseId !== "string" || !p.phaseId) throw new Error("phase.phaseId must be a non-empty string");
    if (typeof p.phaseName !== "string") throw new Error("phase.phaseName must be a string");
    if (typeof p.completed !== "boolean") throw new Error("phase.completed must be a boolean");
    if (!Array.isArray(p.rows)) throw new Error("phase.rows must be an array");
    for (const row of p.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("Each row must be an object");
      }
      const r = row as Record<string, unknown>;
      if (typeof r.rowId !== "string" || !r.rowId) throw new Error("row.rowId must be a non-empty string");
      if (typeof r.rowNumber !== "number") throw new Error("row.rowNumber must be a number");
      if (typeof r.completed !== "boolean") throw new Error("row.completed must be a boolean");
    }
  }
  const result: Record<string, unknown> = { phases: snap.phases };
  if ("mixes" in snap) result.mixes = snap.mixes;
  if ("activeMixNumber" in snap) result.activeMixNumber = snap.activeMixNumber;
  return result;
}

const pestControlRouter = Router();

// Reads needed by both desktop and mobile pest log.
// mobile:pest lets field operators load their assigned jobs and chemical info.
const canMobileView = requireAnyPermission(["mobile:pest", "pest:view", "pest:edit"]);

// Progress saves and job completion — the core mobile pest log writes.
const canMobileWrite = requireAnyPermission(["mobile:pest", "pest:edit"]);

// Desktop-only setup and management: creating/updating/deleting sprayers,
// chemicals, tanks, todos, calibrations, labels, and restocks.
const canEdit = requirePermission("pest:edit");

// ── Sprayers ──────────────────────────────────────────────────────────────────

pestControlRouter.get("/pest/sprayers", canMobileView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("pest_sprayers")
    .select("*, tank:pest_tanks(id, name, volume_liters)")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load sprayers.", "Sprayers fetch error:", error);
  }

  return res.json(data ?? []);
});

pestControlRouter.post("/pest/sprayers", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: SprayerPayload;

  try {
    payload = validateSprayerPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  if (payload.tank_id) {
    const { data: tank } = await supabase
      .from("pest_tanks")
      .select("id")
      .eq("id", payload.tank_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!tank) {
      return res.status(400).json({ message: "Tank not found" });
    }
  }

  const { data, error } = await supabase
    .from("pest_sprayers")
    .insert({ ...payload, organization_id: organizationId })
    .select("*, tank:pest_tanks(id, name, volume_liters)")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create sprayer.", "Sprayer insert error:", error);
  }

  return res.status(201).json(data);
});

pestControlRouter.put("/pest/sprayers/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: SprayerPayload;

  try {
    payload = validateSprayerPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  if (payload.tank_id) {
    const { data: tank } = await supabase
      .from("pest_tanks")
      .select("id")
      .eq("id", payload.tank_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!tank) {
      return res.status(400).json({ message: "Tank not found" });
    }
  }

  const { data, error } = await supabase
    .from("pest_sprayers")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*, tank:pest_tanks(id, name, volume_liters)")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update sprayer.", "Sprayer update error:", error);
  }

  return res.json(data);
});

pestControlRouter.delete("/pest/sprayers/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("pest_sprayers")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete sprayer.", "Sprayer delete error:", error);
  }

  return res.status(204).send();
});

// ── Sprayer Calibrations ──────────────────────────────────────────────────────

const VALID_CALIBRATION_PSI = [50, 100, 150, 200] as const;
type CalibrationPsi = (typeof VALID_CALIBRATION_PSI)[number];

interface CalibrationUpsertRow {
  organization_id: string;
  sprayer_id: string;
  psi: CalibrationPsi;
  nozzle_1_ml_per_min: number;
  nozzle_2_ml_per_min: number;
  nozzle_3_ml_per_min: number;
  notes: string | null;
  updated_at: string;
}

pestControlRouter.get("/pest/calibrations", canMobileView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("pest_sprayer_calibrations")
    .select("*")
    .eq("organization_id", organizationId)
    .order("sprayer_id")
    .order("psi");

  if (error) {
    return sendSafeError(res, 500, "Failed to load calibrations.", "Calibrations fetch:", error);
  }

  return res.json(data ?? []);
});

pestControlRouter.put("/pest/sprayers/:sprayerId/calibration", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const sprayerId = req.params.sprayerId as string;

  const { data: sprayer, error: sprayerError } = await supabase
    .from("pest_sprayers")
    .select("id")
    .eq("id", sprayerId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (sprayerError) {
    return sendSafeError(res, 500, "Failed to verify sprayer.", "Calibration sprayer check:", sprayerError);
  }
  if (!sprayer) {
    return res.status(404).json({ message: "Sprayer not found." });
  }

  const body = req.body as Record<string, unknown>;
  const rawRows = body.rows;
  if (!Array.isArray(rawRows) || rawRows.length !== 4) {
    return res.status(400).json({ message: "All 4 PSI points (50, 100, 150, 200) are required." });
  }

  const globalNotes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  const upsertRows: CalibrationUpsertRow[] = [];

  for (const row of rawRows) {
    if (!row || typeof row !== "object") {
      return res.status(400).json({ message: "Invalid calibration row." });
    }
    const r = row as Record<string, unknown>;
    const psi = Number(r.psi);

    if (!VALID_CALIBRATION_PSI.includes(psi as CalibrationPsi)) {
      return res.status(400).json({ message: `PSI must be one of 50, 100, 150, 200.` });
    }

    const n1 = Number(r.nozzle_1_ml_per_min);
    const n2 = Number(r.nozzle_2_ml_per_min);
    const n3 = Number(r.nozzle_3_ml_per_min);

    if (!Number.isFinite(n1) || n1 <= 0) {
      return res.status(400).json({ message: `Nozzle 1 at ${psi} PSI must be a positive number.` });
    }
    if (!Number.isFinite(n2) || n2 <= 0) {
      return res.status(400).json({ message: `Nozzle 2 at ${psi} PSI must be a positive number.` });
    }
    if (!Number.isFinite(n3) || n3 <= 0) {
      return res.status(400).json({ message: `Nozzle 3 at ${psi} PSI must be a positive number.` });
    }

    upsertRows.push({
      organization_id: organizationId,
      sprayer_id: sprayerId,
      psi: psi as CalibrationPsi,
      nozzle_1_ml_per_min: n1,
      nozzle_2_ml_per_min: n2,
      nozzle_3_ml_per_min: n3,
      notes: globalNotes,
      updated_at: new Date().toISOString()
    });
  }

  const psiValues = upsertRows.map((r) => r.psi);
  for (const required of VALID_CALIBRATION_PSI) {
    if (!psiValues.includes(required)) {
      return res.status(400).json({ message: `Missing PSI point: ${required}.` });
    }
  }

  const { data, error } = await supabase
    .from("pest_sprayer_calibrations")
    .upsert(upsertRows, { onConflict: "sprayer_id,psi" })
    .select("*")
    .order("psi");

  if (error) {
    return sendSafeError(res, 500, "Failed to save calibration.", "Calibration upsert:", error);
  }

  return res.json(data ?? []);
});

// ── Chemicals ────────────────────────────────────────────────────────────────

const CHEMICAL_TYPES = ["fungicide", "insecticide", "herbicide", "pesticide"] as const;
type ChemicalType = (typeof CHEMICAL_TYPES)[number];

type ChemicalPayload = {
  name: string;
  active: boolean;
  inventory_qty: number;
  inventory_unit: string;
  pest_target: string;
  notes: string | null;
  phi: string | null;
  chemical_group: string | null;
  chemical_type: ChemicalType | null;
  active_ingredients: string | null;
  registration_number: string | null;
};

type ChemicalRestockPayload = {
  amount: number;
  note: string | null;
};

function parseBoolean(value: unknown, fieldName: string): boolean {
  if (value === true || value === false) {
    return value;
  }
  throw new Error(`${fieldName} must be true or false`);
}

function parseOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value.trim() : "";
  return s || null;
}

function validateChemicalPayload(input: unknown): ChemicalPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    throw new Error("name is required");
  }

  const inventory_qty =
    typeof body.inventory_qty === "number" ? body.inventory_qty : Number(body.inventory_qty);
  if (!Number.isFinite(inventory_qty) || inventory_qty < 0) {
    throw new Error("inventory_qty must be 0 or greater");
  }

  const inventory_unit =
    typeof body.inventory_unit === "string" ? body.inventory_unit.trim() : "";
  if (!inventory_unit) {
    throw new Error("inventory_unit is required");
  }

  const chemical_type_raw = parseOptionalText(body.chemical_type);
  if (
    chemical_type_raw !== null &&
    !CHEMICAL_TYPES.includes(chemical_type_raw as ChemicalType)
  ) {
    throw new Error(
      "chemical_type must be fungicide, insecticide, herbicide, or pesticide"
    );
  }

  return {
    name,
    active: parseBoolean(body.active, "active"),
    inventory_qty,
    inventory_unit,
    pest_target: typeof body.pest_target === "string" ? body.pest_target.trim() : "",
    notes: parseOptionalText(body.notes),
    phi: parseOptionalText(body.phi),
    chemical_group: parseOptionalText(body.chemical_group),
    chemical_type: chemical_type_raw as ChemicalType | null,
    active_ingredients: parseOptionalText(body.active_ingredients),
    registration_number: parseOptionalText(body.registration_number)
  };
}

function validateChemicalRestockPayload(input: unknown): ChemicalRestockPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount must be greater than 0");
  }

  return {
    amount,
    note: parseOptionalText(body.note)
  };
}

pestControlRouter.get("/pest/chemicals", canMobileView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("pest_chemicals")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (error) {
    return sendSafeError(
      res,
      500,
      "Failed to load chemicals.",
      "Chemicals fetch error:",
      error
    );
  }

  return res.json(data ?? []);
});

pestControlRouter.post("/pest/chemicals", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: ChemicalPayload;

  try {
    payload = validateChemicalPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("pest_chemicals")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(
      res,
      500,
      "Failed to create chemical.",
      "Chemical insert error:",
      error
    );
  }

  return res.status(201).json(data);
});

pestControlRouter.put("/pest/chemicals/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: ChemicalPayload;

  try {
    payload = validateChemicalPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("pest_chemicals")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(
      res,
      500,
      "Failed to update chemical.",
      "Chemical update error:",
      error
    );
  }

  return res.json(data);
});

pestControlRouter.post("/pest/chemicals/:id/restock", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: ChemicalRestockPayload;

  try {
    payload = validateChemicalRestockPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data: chemical, error: fetchError } = await supabase
    .from("pest_chemicals")
    .select("id, inventory_qty, inventory_unit")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(
      res,
      500,
      "Failed to restock chemical.",
      "Chemical restock fetch error:",
      fetchError
    );
  }

  if (!chemical) {
    return res.status(404).json({ message: "Chemical not found" });
  }

  const currentInventoryQty = Number(chemical.inventory_qty);
  if (!Number.isFinite(currentInventoryQty) || currentInventoryQty < 0) {
    return res.status(500).json({ message: "Chemical has invalid inventory quantity" });
  }

  const inventory_qty = currentInventoryQty + payload.amount;

  const { data, error } = await supabase
    .from("pest_chemicals")
    .update({ inventory_qty, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(
      res,
      500,
      "Failed to restock chemical.",
      "Chemical restock update error:",
      error
    );
  }

  return res.json(data);
});

pestControlRouter.delete("/pest/chemicals/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  // Block delete when any active todos reference this chemical
  const { data: activeTodos, error: todosError } = await supabase
    .from("pest_control_todos")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("chemical_id", id)
    .in("status", ["pending", "in_progress"])
    .limit(1);

  if (todosError) {
    return sendSafeError(res, 500, "Failed to check active jobs.", "Todos check error:", todosError);
  }
  if (activeTodos && activeTodos.length > 0) {
    return res.status(409).json({ message: "Cannot delete: this chemical has pending or in-progress jobs." });
  }

  // Fetch label path before delete so we can clean up storage
  const { data: chemical } = await supabase
    .from("pest_chemicals")
    .select("label_pdf_path")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  const { error } = await supabase
    .from("pest_chemicals")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(
      res,
      500,
      "Failed to delete chemical.",
      "Chemical delete error:",
      error
    );
  }

  // Best-effort storage cleanup — row is already deleted, so don't fail on storage error
  if (chemical?.label_pdf_path) {
    await supabase.storage
      .from("pest-chemical-labels")
      .remove([chemical.label_pdf_path]);
  }

  return res.status(204).send();
});

// ── Chemical label PDF ────────────────────────────────────────────────────────

const CHEMICAL_LABELS_BUCKET = "pest-chemical-labels";

const labelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are accepted"));
    }
  }
});

// POST /api/pest/chemicals/:id/label
// canEdit checked before multer so we avoid parsing the upload for unauthorized users.
pestControlRouter.post(
  "/pest/chemicals/:id/label",
  canEdit,
  labelUpload.single("label"),
  async (req, res) => {
    const organizationId = req.organizationId;
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ message: "No file provided" });
    }

    // Verify ownership and fetch existing path
    const { data: chemical, error: fetchError } = await supabase
      .from("pest_chemicals")
      .select("id, label_pdf_path")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .single();

    if (fetchError || !chemical) {
      return res.status(404).json({ message: "Chemical not found" });
    }

    // Remove previous label file if one exists
    if (chemical.label_pdf_path) {
      await supabase.storage
        .from(CHEMICAL_LABELS_BUCKET)
        .remove([chemical.label_pdf_path]);
    }

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const storagePath = `${organizationId}/${id}/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(CHEMICAL_LABELS_BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: "application/pdf",
        upsert: false
      });

    if (uploadError) {
      return sendSafeError(
        res,
        500,
        "Failed to upload label.",
        "Label upload error:",
        uploadError
      );
    }

    const { error: updateError } = await supabase
      .from("pest_chemicals")
      .update({ label_pdf_path: storagePath, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", organizationId);

    if (updateError) {
      return sendSafeError(
        res,
        500,
        "Failed to save label path.",
        "Label path update error:",
        updateError
      );
    }

    return res.json({ label_pdf_path: storagePath });
  }
);

// GET /api/pest/chemicals/:id/label-url  — returns a 1-hour signed URL
pestControlRouter.get("/pest/chemicals/:id/label-url", canMobileView, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { data: chemical, error } = await supabase
    .from("pest_chemicals")
    .select("label_pdf_path")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (error || !chemical) {
    return res.status(404).json({ message: "Chemical not found" });
  }

  if (!chemical.label_pdf_path) {
    return res.status(404).json({ message: "No label uploaded" });
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(CHEMICAL_LABELS_BUCKET)
    .createSignedUrl(chemical.label_pdf_path, 3600);

  if (signError || !signed) {
    return sendSafeError(
      res,
      500,
      "Failed to generate label URL.",
      "Signed URL error:",
      signError
    );
  }

  return res.json({ url: signed.signedUrl });
});

// DELETE /api/pest/chemicals/:id/label
pestControlRouter.delete("/pest/chemicals/:id/label", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { data: chemical, error } = await supabase
    .from("pest_chemicals")
    .select("label_pdf_path")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (error || !chemical) {
    return res.status(404).json({ message: "Chemical not found" });
  }

  if (!chemical.label_pdf_path) {
    return res.status(200).json({ ok: true });
  }

  const { error: removeError } = await supabase.storage
    .from(CHEMICAL_LABELS_BUCKET)
    .remove([chemical.label_pdf_path]);

  if (removeError) {
    return sendSafeError(
      res,
      500,
      "Failed to delete label.",
      "Label delete error:",
      removeError
    );
  }

  const { error: updateError } = await supabase
    .from("pest_chemicals")
    .update({ label_pdf_path: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (updateError) {
    return sendSafeError(
      res,
      500,
      "Failed to clear label path.",
      "Label path clear error:",
      updateError
    );
  }

  return res.status(204).send();
});

// ── Tanks ─────────────────────────────────────────────────────────────────────

type TankPayload = {
  name: string;
  volume_liters: number;
  active: boolean;
};

function validateTankPayload(input: unknown): TankPayload {
  if (!input || typeof input !== "object") throw new Error("Invalid request body");
  const body = input as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new Error("name is required");

  const volume_liters = typeof body.volume_liters === "number" ? body.volume_liters : Number(body.volume_liters);
  if (!Number.isFinite(volume_liters) || volume_liters <= 0) {
    throw new Error("volume_liters must be greater than 0");
  }

  const active = body.active === undefined ? true : parseBoolean(body.active, "active");

  return { name, volume_liters, active };
}

pestControlRouter.get("/pest/tanks", canMobileView, async (req, res) => {
  const organizationId = req.organizationId;
  const { data, error } = await supabase
    .from("pest_tanks")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) {
    return sendSafeError(res, 500, "Failed to load tanks.", "Tanks fetch error:", error);
  }
  return res.json(data ?? []);
});

pestControlRouter.post("/pest/tanks", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: TankPayload;
  try {
    payload = validateTankPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }
  const { data, error } = await supabase
    .from("pest_tanks")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();
  if (error) {
    return sendSafeError(res, 500, "Failed to create tank.", "Tank insert error:", error);
  }
  return res.status(201).json(data);
});

pestControlRouter.put("/pest/tanks/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: TankPayload;
  try {
    payload = validateTankPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }
  const { data, error } = await supabase
    .from("pest_tanks")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) {
    return sendSafeError(res, 500, "Failed to update tank.", "Tank update error:", error);
  }
  return res.json(data);
});

pestControlRouter.delete("/pest/tanks/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  const { error } = await supabase
    .from("pest_tanks")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) {
    return sendSafeError(res, 500, "Failed to delete tank.", "Tank delete error:", error);
  }
  return res.status(204).send();
});

// ── Pest Control Todos ────────────────────────────────────────────────────────

pestControlRouter.get("/pest/todos", canMobileView, async (req, res) => {
  const organizationId = req.organizationId;
  const { status } = req.query;

  let query = supabase
    .from("pest_control_todos")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (status === "active") {
    query = query.in("status", ["pending", "in_progress"]);
  } else if (status === "pending" || status === "in_progress" || status === "completed" || status === "cancelled") {
    query = query.eq("status", status as string);
  }

  const { data, error } = await query;
  if (error) {
    return sendSafeError(res, 500, "Failed to load todos.", "Todos fetch error:", error);
  }
  return res.json(data ?? []);
});

pestControlRouter.post("/pest/todos", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const body = req.body as Record<string, unknown>;

  const type = body.type;
  if (type !== "spray" && type !== "drench") {
    return res.status(400).json({ message: "type must be spray or drench" });
  }

  const chemical_id = typeof body.chemical_id === "string" && body.chemical_id ? body.chemical_id : null;
  if (chemical_id) {
    const { data: chem } = await supabase
      .from("pest_chemicals")
      .select("id")
      .eq("id", chemical_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!chem) {
      return res.status(400).json({ message: "Chemical not found" });
    }
  }

  const instructions = typeof body.instructions === "string" ? body.instructions.trim() || null : null;

  // Accept a pre-built progress_snapshot (e.g. valve_drench) sent from the planner.
  let initial_progress_snapshot: Record<string, unknown> | null = null;
  if (body.progress_snapshot != null) {
    try {
      initial_progress_snapshot = validateProgressSnapshot(body.progress_snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid progress_snapshot";
      return res.status(400).json({ message });
    }
  }

  const { data, error } = await supabase
    .from("pest_control_todos")
    .insert({
      organization_id: organizationId,
      type,
      status: "pending",
      chemical_id,
      chemical_snapshot: pickSnapshotKeys(body.chemical_snapshot, CHEMICAL_SNAP_KEYS),
      target_snapshot: pickSnapshotKeys(body.target_snapshot, TARGET_SNAP_KEYS),
      sprayer_snapshot: pickSnapshotKeys(body.sprayer_snapshot, SPRAYER_SNAP_KEYS),
      tank_snapshot: pickSnapshotKeys(body.tank_snapshot, TANK_SNAP_KEYS),
      calculation_snapshot: pickSnapshotKeys(body.calculation_snapshot, CALC_SNAP_KEYS),
      progress_snapshot: initial_progress_snapshot,
      instructions,
      created_by: userId ?? null
    })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create todo.", "Todo insert error:", error);
  }
  return res.status(201).json(data);
});

pestControlRouter.patch("/pest/todos/:id/status", canMobileWrite, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const status = body.status;
  if (status !== "in_progress" && status !== "completed" && status !== "cancelled") {
    return res.status(400).json({ message: "status must be in_progress, completed, or cancelled" });
  }

  const updates: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "completed") {
    updates.completed_by = userId ?? null;
    updates.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("pest_control_todos")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update todo.", "Todo update error:", error);
  }
  if (!data) {
    return res.status(404).json({ message: "Todo not found" });
  }
  return res.json(data);
});

pestControlRouter.patch("/pest/todos/:id/progress", canMobileWrite, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  let progress_snapshot: Record<string, unknown>;
  try {
    progress_snapshot = validateProgressSnapshot(body.progress_snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid progress_snapshot";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("pest_control_todos")
    .update({
      progress_snapshot,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, progress_snapshot")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to save progress.", "Progress update error:", error);
  }
  if (!data) {
    return res.status(404).json({ message: "Todo not found" });
  }
  return res.json(data);
});

// POST /pest/todos/:id/complete — verifies completion, saves record, marks todo completed
pestControlRouter.post("/pest/todos/:id/complete", canMobileWrite, async (req, res) => {
  const organizationId = req.organizationId;
  const userId = req.userId;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  // Load the todo
  const { data: todo, error: fetchError } = await supabase
    .from("pest_control_todos")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(res, 500, "Failed to load todo.", "Todo fetch error:", fetchError);
  }
  if (!todo) {
    return res.status(404).json({ message: "Todo not found" });
  }

  // Idempotent: already completed — return success without inserting another record
  if (todo.status === "completed") {
    const { data: existingRecord } = await supabase
      .from("pest_control_records")
      .select("id")
      .eq("todo_id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (existingRecord) {
      return res.json({ ok: true, already_completed: true });
    }
  }

  // Verify completion — branch on snapshot type
  type SnapRow = { completed: boolean };
  type SnapPhase = { completed: boolean; rows?: SnapRow[] };
  type SnapValve = { completed: boolean };
  const snap = todo.progress_snapshot as {
    type?: string;
    phases?: SnapPhase[];
    valves?: SnapValve[];
  };

  if (snap.type === "valve_drench") {
    if (!snap.valves || snap.valves.length === 0) {
      return res.status(400).json({ message: "No valves found in plan." });
    }
    if (!snap.valves.every((v) => v.completed)) {
      return res.status(400).json({ message: "All valves must be completed before finishing." });
    }
  } else if (snap.phases && snap.phases.length > 0) {
    const allPhasesComplete = snap.phases.every((p) => p.completed);
    const allRowsComplete = snap.phases.every((p) => (p.rows ?? []).every((r) => r.completed));
    if (!allPhasesComplete || !allRowsComplete) {
      return res.status(400).json({ message: "Job is not fully complete yet." });
    }
  }

  const now = new Date().toISOString();
  const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;

  // Insert permanent record
  const { error: insertError } = await supabase
    .from("pest_control_records")
    .insert({
      organization_id: organizationId,
      todo_id: id,
      type: todo.type as string,
      chemical_id: (todo.chemical_id as string | null) ?? null,
      chemical_snapshot: todo.chemical_snapshot,
      target_snapshot: todo.target_snapshot,
      sprayer_snapshot: todo.sprayer_snapshot,
      tank_snapshot: todo.tank_snapshot,
      calculation_snapshot: todo.calculation_snapshot,
      progress_snapshot: todo.progress_snapshot,
      completed_by: userId ?? null,
      completed_at: now,
      notes
    });

  if (insertError) {
    return sendSafeError(res, 500, "Failed to save record.", "Record insert error:", insertError);
  }

  // Mark todo completed
  const { data: updatedTodo, error: updateError } = await supabase
    .from("pest_control_todos")
    .update({
      status: "completed",
      completed_by: userId ?? null,
      completed_at: now,
      updated_at: now
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, status, completed_at")
    .single();

  if (updateError) {
    return sendSafeError(res, 500, "Failed to complete todo.", "Todo update error:", updateError);
  }

  // ── Inventory deduction ─────────────────────────────────────────────────────
  // For valve_drench: sum the displayed-rounded per-valve amounts from the
  // progress_snapshot (matching exactly what the operator was told to apply).
  //   dry (g)  → each valve rounded to nearest 5 g
  //   wet (ml) → each valve rounded to 1 decimal ml
  // For all other todos: use calculation_snapshot.total_chemical_ml (raw total).
  const chemId = (todo.chemical_id as string | null) ?? null;
  if (chemId) {
    const chemSnap = todo.chemical_snapshot as Record<string, unknown> | null;
    const rateUnit = typeof chemSnap?.rate_unit === "string" ? chemSnap.rate_unit : null;

    let totalBaseUnits: number | null = null;
    let isDry = false;

    if (snap.type === "valve_drench" && Array.isArray(snap.valves) && snap.valves.length > 0) {
      type ValveAmt = { productAmount: unknown; productUnit: unknown };
      const valves = snap.valves as unknown as ValveAmt[];
      const firstUnit = typeof valves[0]?.productUnit === "string" ? valves[0].productUnit : "";
      isDry = firstUnit === "g";
      let sum = 0;
      for (const v of valves) {
        const amt = typeof v.productAmount === "number" ? v.productAmount : 0;
        const unit = typeof v.productUnit === "string" ? v.productUnit : "";
        // Mirror the display rounding used by the mobile valve cards.
        const rounded = unit === "g"
          ? Math.round(amt / 5) * 5          // nearest 5 g
          : Math.round(amt * 10) / 10;        // 1 decimal ml
        sum += rounded;
      }
      totalBaseUnits = sum;
    } else if (rateUnit) {
      const calcSnap = todo.calculation_snapshot as Record<string, unknown> | null;
      totalBaseUnits = typeof calcSnap?.total_chemical_ml === "number" ? calcSnap.total_chemical_ml : null;
      isDry = rateUnit.startsWith("g_") || rateUnit.startsWith("kg_");
    }

    if (totalBaseUnits != null && totalBaseUnits > 0) {
      const { data: chemRow } = await supabase
        .from("pest_chemicals")
        .select("inventory_qty, inventory_unit")
        .eq("id", chemId)
        .eq("organization_id", organizationId)
        .maybeSingle();

      if (chemRow) {
        const invUnit = (chemRow.inventory_unit as string | null) ?? "";
        // Convert base units (g for dry, ml for wet) to the stored inventory unit.
        let deductInInvUnit: number | null = null;
        if (!isDry) {
          if (invUnit === "ml") deductInInvUnit = totalBaseUnits;
          else if (invUnit === "L") deductInInvUnit = totalBaseUnits / 1000;
        } else {
          if (invUnit === "g") deductInInvUnit = totalBaseUnits;
          else if (invUnit === "kg") deductInInvUnit = totalBaseUnits / 1000;
        }

        if (deductInInvUnit != null) {
          const currentQty = typeof chemRow.inventory_qty === "number" ? chemRow.inventory_qty : 0;
          const newQty = Math.max(0, currentQty - deductInInvUnit);
          await supabase
            .from("pest_chemicals")
            .update({ inventory_qty: newQty, updated_at: now })
            .eq("id", chemId)
            .eq("organization_id", organizationId);
        } else {
          console.warn(
            `[pest-complete] Cannot deduct inventory: unit mismatch` +
            ` (base=${isDry ? "g" : "ml"}, inv=${invUnit}) for chemical ${chemId}`
          );
        }
      }
    }
  }

  return res.json({ ok: true, todo: updatedTodo });
});

// GET /pest/records — org-scoped completed records, newest first
pestControlRouter.get("/pest/records", canMobileView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("pest_control_records")
    .select("*")
    .eq("organization_id", organizationId)
    .order("completed_at", { ascending: false });

  if (error) {
    return sendSafeError(res, 500, "Failed to load records.", "Records fetch error:", error);
  }

  return res.json(data ?? []);
});

// DELETE /pest/todos/:id — only allows deleting pending/in-progress todos
pestControlRouter.delete("/pest/todos/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { data: todo, error: fetchError } = await supabase
    .from("pest_control_todos")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(res, 500, "Failed to load todo.", "Todo delete fetch error:", fetchError);
  }
  if (!todo) {
    return res.status(404).json({ message: "Todo not found" });
  }
  if (todo.status === "completed") {
    return res.status(409).json({ message: "Completed plans cannot be deleted." });
  }

  const { error: deleteError } = await supabase
    .from("pest_control_todos")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (deleteError) {
    return sendSafeError(res, 500, "Failed to delete todo.", "Todo delete error:", deleteError);
  }

  return res.json({ success: true });
});

export { pestControlRouter };
