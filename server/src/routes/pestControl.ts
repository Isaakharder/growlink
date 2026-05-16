import multer from "multer";
import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";

type SprayerPayload = {
  name: string;
  nozzle_count: number;
  nozzle_volume_l_per_min: number;
  nozzle_psi: number;
  speed_m_per_min: number;
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

function parseSpeedMPerMin(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 20 || parsed > 80) {
    throw new Error("speed_m_per_min must be between 20 and 80");
  }
  return parsed;
}

function validateSprayerPayload(input: unknown): SprayerPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;

  return {
    name: parseRequiredName(body.name),
    nozzle_count: parsePositiveInteger(body.nozzle_count, "nozzle_count"),
    nozzle_volume_l_per_min: parseNonNegativeNumber(
      body.nozzle_volume_l_per_min,
      "nozzle_volume_l_per_min"
    ),
    nozzle_psi: parseNonNegativeNumber(body.nozzle_psi, "nozzle_psi"),
    speed_m_per_min: parseSpeedMPerMin(body.speed_m_per_min)
  };
}

const pestControlRouter = Router();

pestControlRouter.get("/pest/sprayers", async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("pest_sprayers")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load sprayers.", "Sprayers fetch error:", error);
  }

  return res.json(data ?? []);
});

pestControlRouter.post("/pest/sprayers", async (req, res) => {
  const organizationId = req.organizationId;
  let payload: SprayerPayload;

  try {
    payload = validateSprayerPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("pest_sprayers")
    .insert({ ...payload, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to create sprayer.", "Sprayer insert error:", error);
  }

  return res.status(201).json(data);
});

pestControlRouter.put("/pest/sprayers/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;
  let payload: SprayerPayload;

  try {
    payload = validateSprayerPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const { data, error } = await supabase
    .from("pest_sprayers")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to update sprayer.", "Sprayer update error:", error);
  }

  return res.json(data);
});

pestControlRouter.delete("/pest/sprayers/:id", async (req, res) => {
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

pestControlRouter.get("/pest/chemicals", async (req, res) => {
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

pestControlRouter.post("/pest/chemicals", async (req, res) => {
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

pestControlRouter.put("/pest/chemicals/:id", async (req, res) => {
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

pestControlRouter.delete("/pest/chemicals/:id", async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

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
pestControlRouter.post(
  "/pest/chemicals/:id/label",
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

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
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
pestControlRouter.get("/pest/chemicals/:id/label-url", async (req, res) => {
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
pestControlRouter.delete("/pest/chemicals/:id/label", async (req, res) => {
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

export { pestControlRouter };
