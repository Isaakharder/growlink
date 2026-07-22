import { Router } from "express";
import multer from "multer";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission } from "../middleware/requirePermission";
import { parseBonusPdfBuffer } from "../utils/bonusPdfParser";
import { matchEmployeeName, type EmployeeMatchCandidate } from "../utils/employeeNameMatch";
import {
  computeBonusBatch,
  getAdjustmentSettings,
  isCheckType,
  LINEAR_ADJUSTMENT_DEFAULTS,
  round2,
  speedUnitFor,
  type CheckType,
  type WeeklyConditions
} from "../utils/bonusCalc";

const router = Router();

const canEdit = requirePermission("quality:bonuses_edit");

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const isPdf = file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname);
    if (isPdf) {
      cb(null, true);
      return;
    }
    cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
  }
});

function parseWeeklyConditions(value: unknown): WeeklyConditions {
  if (!value || typeof value !== "object") return {};
  const r = value as Record<string, unknown>;
  const cropLoad = r.cropLoad !== undefined && r.cropLoad !== null && r.cropLoad !== "" ? Number(r.cropLoad) : null;
  const setsPerPlant =
    r.setsPerPlant !== undefined && r.setsPerPlant !== null && r.setsPerPlant !== "" ? Number(r.setsPerPlant) : null;
  return {
    cropLoad: cropLoad !== null && Number.isFinite(cropLoad) ? cropLoad : null,
    setsPerPlant: setsPerPlant !== null && Number.isFinite(setsPerPlant) ? setsPerPlant : null
  };
}

// ── Step 1: parse the PDF + match employees. No bonus calc yet — the admin ──
// still needs to supply Weekly Bonus Conditions (for auto-adjusting jobs)
// before a meaningful rate can be computed.

router.post("/quality/bonus-pdf-import/preview", canEdit, (req, res) => {
  upload.single("file")(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError) {
        if (uploadError.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ message: "The PDF must be 10MB or smaller." });
        }
        return res.status(400).json({ message: "Only a single PDF file is allowed." });
      }
      console.error("Bonus PDF preview upload middleware error:", uploadError);
      return res.status(500).json({ message: "Failed to process upload." });
    }

    const file = req.file;
    if (!file) return res.status(400).json({ message: "Please upload a PDF file." });

    const orgId = req.organizationId;

    let parsed;
    try {
      parsed = await parseBonusPdfBuffer(file.buffer, file.originalname);
    } catch (err) {
      return sendSafeError(res, 500, "Failed to read the PDF.", "bonus pdf parse:", err);
    }

    if (!parsed.checkType) {
      return res.status(400).json({
        message: "Could not determine the job for this report (expected every row to use the same Kg/Hr or Plants/Hr unit).",
        warnings: parsed.warnings
      });
    }
    const checkType = parsed.checkType;

    const [employeesResult, adjustmentSettings] = await Promise.all([
      supabase.from("quality_employees").select("id, name").eq("organization_id", orgId).eq("active", true),
      getAdjustmentSettings(orgId, checkType).catch((err) => {
        console.error("bonus pdf preview adjustment settings lookup:", err);
        return { thresholdMode: "fixed" as const, linear: LINEAR_ADJUSTMENT_DEFAULTS[checkType] };
      })
    ]);
    if (employeesResult.error) {
      return sendSafeError(res, 500, "Failed to load employees.", "bonus pdf preview employees select:", employeesResult.error);
    }
    const candidates = (employeesResult.data ?? []) as EmployeeMatchCandidate[];

    const rows = parsed.rows.map((row) => {
      const match = matchEmployeeName(row.rawName, candidates);
      return {
        rawName: row.rawName,
        enteredSpeed: row.enteredSpeed,
        speedUnit: speedUnitFor(checkType),
        hoursWorked: row.hoursWorked,
        matchStatus: match.status,
        employeeId: match.employeeId,
        suggestions: match.suggestions
      };
    });

    return res.json({
      sourceFile: parsed.sourceFile,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      company: parsed.company,
      checkType,
      speedUnit: speedUnitFor(checkType),
      warnings: parsed.warnings,
      grandTotal: parsed.grandTotal,
      thresholdMode: adjustmentSettings.thresholdMode,
      rows
    });
  });
});

// ── Step 2: given the parsed rows + Weekly Bonus Conditions, compute the ────
// (possibly adjusted) threshold/rate/total for every row. Stateless — called
// again each time the admin edits the weekly conditions. No DB writes.

router.post("/quality/bonus-pdf-import/calculate", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const body = req.body as Record<string, unknown>;

  if (!isCheckType(body.checkType)) return res.status(400).json({ message: "checkType is required" });
  const checkType = body.checkType as CheckType;

  if (!Array.isArray(body.rows)) return res.status(400).json({ message: "rows array is required" });
  const speeds: number[] = [];
  for (const item of body.rows) {
    if (!item || typeof item !== "object") return res.status(400).json({ message: "Invalid rows payload" });
    const speed = Number((item as Record<string, unknown>).enteredSpeed);
    if (!Number.isFinite(speed)) return res.status(400).json({ message: "Invalid enteredSpeed in rows payload" });
    speeds.push(speed);
  }

  const conditions = parseWeeklyConditions(body.weeklyConditions);

  try {
    const { mode, rawAdjustment, finalAdjustment, linearSettings, results } = await computeBonusBatch(
      orgId,
      checkType,
      speeds,
      conditions
    );
    const rows = results.map((r, i) => {
      const hoursWorked = Number((body.rows as Record<string, unknown>[])[i].hoursWorked) || 0;
      return {
        baseThreshold: r.base_threshold,
        appliedThreshold: r.applied_threshold,
        appliedRate: r.applied_rate,
        totalBonus: round2(r.applied_rate * hoursWorked)
      };
    });
    return res.json({
      mode,
      rawAdjustment,
      finalAdjustment,
      linearSettings: linearSettings
        ? {
            standardValue: linearSettings.standardValue,
            valueStep: linearSettings.valueStep,
            speedChangePerStep: linearSettings.speedChangePerStep,
            minAdjustment: linearSettings.minAdjustment,
            maxAdjustment: linearSettings.maxAdjustment
          }
        : null,
      rows
    });
  } catch (err) {
    return sendSafeError(res, 500, "Failed to calculate bonus.", "bonus pdf calculate:", err);
  }
});

// ── Step 3: commit admin-confirmed rows ──────────────────────────────────────

type ImportRow = {
  rawName: string;
  employeeId: string;
  enteredSpeed: number;
  hoursWorked: number;
};

function parseImportRows(value: unknown): ImportRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: ImportRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    const rawName = typeof r.rawName === "string" ? r.rawName : "";
    const employeeId = typeof r.employeeId === "string" ? r.employeeId.trim() : "";
    const enteredSpeed = Number(r.enteredSpeed);
    const hoursWorked = Number(r.hoursWorked);
    if (!employeeId || !Number.isFinite(enteredSpeed) || !Number.isFinite(hoursWorked)) return null;
    rows.push({ rawName, employeeId, enteredSpeed, hoursWorked });
  }
  return rows;
}

router.post("/quality/bonus-pdf-import/import", canEdit, async (req, res) => {
  const orgId = req.organizationId;
  const userId = req.userId;
  const body = req.body as Record<string, unknown>;

  const entry_date = typeof body.entryDate === "string" ? body.entryDate.trim() : "";
  if (!isCheckType(body.checkType)) return res.status(400).json({ message: "checkType is required" });
  if (!entry_date) return res.status(400).json({ message: "entryDate is required" });

  const rows = parseImportRows(body.rows);
  if (!rows || rows.length === 0) return res.status(400).json({ message: "At least one row is required" });

  const checkType = body.checkType as CheckType;
  const conditions = parseWeeklyConditions(body.weeklyConditions);

  const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
  const { data: employees, error: employeesError } = await supabase
    .from("quality_employees")
    .select("id, name")
    .eq("organization_id", orgId)
    .in("id", employeeIds);
  if (employeesError) {
    return sendSafeError(res, 500, "Failed to validate employees.", "bonus pdf import employees select:", employeesError);
  }
  const employeeById = new Map((employees ?? []).map((e) => [e.id, e.name as string]));

  // Server always recomputes authoritative values itself, in one batch,
  // rather than trusting client-submitted rate/threshold numbers.
  let batch: Awaited<ReturnType<typeof computeBonusBatch>>;
  try {
    batch = await computeBonusBatch(orgId, checkType, rows.map((r) => r.enteredSpeed), conditions);
  } catch (err) {
    return sendSafeError(res, 500, "Failed to calculate bonus.", "bonus pdf import calc:", err);
  }

  const results: { rawName: string; status: "imported" | "failed"; message?: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const applied = batch.results[i];
    const employeeName = employeeById.get(row.employeeId);
    if (!employeeName) {
      results.push({ rawName: row.rawName, status: "failed", message: "Employee not found" });
      continue;
    }

    try {
      const total_bonus = round2(applied.applied_rate * row.hoursWorked);
      const { error } = await supabase.from("quality_bonus_entries").insert({
        organization_id: orgId,
        employee_id: row.employeeId,
        employee_name: employeeName,
        entry_date,
        check_type: checkType,
        entered_speed: row.enteredSpeed,
        speed_unit: speedUnitFor(checkType),
        hours_worked: row.hoursWorked,
        applied_threshold: applied.applied_threshold,
        applied_rate: applied.applied_rate,
        base_threshold: applied.base_threshold,
        raw_adjustment: applied.raw_adjustment,
        final_adjustment: applied.final_adjustment,
        weekly_crop_load: conditions.cropLoad ?? null,
        weekly_sets_per_plant: conditions.setsPerPlant ?? null,
        standard_value_used: batch.linearSettings?.standardValue ?? null,
        value_step_used: batch.linearSettings?.valueStep ?? null,
        speed_change_per_step_used: batch.linearSettings?.speedChangePerStep ?? null,
        min_adjustment_used: batch.linearSettings?.minAdjustment ?? null,
        max_adjustment_used: batch.linearSettings?.maxAdjustment ?? null,
        total_bonus,
        created_by: userId
      });
      if (error) throw error;
      results.push({ rawName: row.rawName, status: "imported" });
    } catch (err) {
      console.error("bonus pdf import row insert:", err);
      results.push({ rawName: row.rawName, status: "failed", message: "Failed to save this row" });
    }
  }

  const importedCount = results.filter((r) => r.status === "imported").length;
  return res.json({ importedCount, results });
});

export { router as qualityBonusPdfImportRouter };
