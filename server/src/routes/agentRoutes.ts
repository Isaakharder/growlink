import multer from "multer";
import { Request, Response, Router } from "express";
import { supabase } from "../config/supabase";
import { requireUploadKey } from "../middleware/requireUploadKey";
import { parseFlowMasterPdfBuffer } from "../utils/flowMasterPdfParser";
import {
  parseFlowMasterStartTimeToIso,
  calculateTotals,
  mapSizeNamesToIds,
  type ActiveYieldSizeWithId,
  type VarietyForCalc
} from "./pdfImport";

const agentRouter = Router();

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_REQUEST
  },
  fileFilter(_req, file, cb) {
    const isPdf =
      file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname);
    if (isPdf) {
      cb(null, true);
    } else {
      cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
    }
  }
});

// POST /api/agent/ping
// Validates the upload key and returns org name + key label.
agentRouter.post("/agent/ping", requireUploadKey, async (req: Request, res: Response) => {
  const { data: org, error } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", req.organizationId)
    .single();

  if (error || !org) {
    return res.status(500).json({ message: "Failed to resolve organization." });
  }

  return res.json({
    success: true,
    organizationName: org.name,
    keyLabel: req.uploadKeyLabel
  });
});

type FileResult =
  | {
      filename: string;
      status: "imported";
      mode: "create" | "append";
      lotNumber: string;
      varietyName: string;
      isoYear: number;
      isoWeek: number;
      totalKg: number;
    }
  | {
      filename: string;
      status: "skipped";
      reason: "already_imported" | "duplicate_in_batch";
      lotNumber: string;
    }
  | { filename: string; status: "error"; reason: string };

// POST /api/agent/pdf-import
// Accepts multipart PDFs, validates each against the org, and imports automatically.
// PDFs are processed sequentially to prevent race conditions on yield_entries.
agentRouter.post("/agent/pdf-import", requireUploadKey, (req: Request, res: Response) => {
  upload.array("files", MAX_FILES_PER_REQUEST)(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError) {
        if (uploadError.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ message: "Each PDF must be 15MB or smaller." });
        }
        if (uploadError.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({
            message: `You can upload up to ${MAX_FILES_PER_REQUEST} PDFs at once.`
          });
        }
        return res.status(400).json({ message: "Only PDF files are allowed." });
      }
      console.error("Agent PDF upload error:", uploadError);
      return res.status(500).json({ message: "Failed to process upload." });
    }

    const uploadedFiles = Array.isArray(req.files)
      ? (req.files as Express.Multer.File[])
      : [];

    if (uploadedFiles.length === 0) {
      return res.status(400).json({ message: "Please upload at least one PDF file." });
    }

    const organizationId = req.organizationId;

    const [varietiesResult, activeSizesResult] = await Promise.all([
      supabase
        .from("varieties")
        .select("id, name, area_m2, case_kg")
        .eq("organization_id", organizationId)
        .eq("status", "active"),
      supabase
        .from("yield_sizes")
        .select("id, name")
        .eq("organization_id", organizationId)
        .eq("status", "active")
    ]);

    if (varietiesResult.error) {
      return res.status(500).json({ message: "Failed to load active varieties." });
    }

    if (activeSizesResult.error) {
      return res.status(500).json({ message: "Failed to load active yield sizes." });
    }

    const activeVarieties = (varietiesResult.data ?? []) as Array<{
      id: string;
      name: string;
      area_m2: number;
      case_kg: number;
    }>;
    const activeSizes = (activeSizesResult.data ?? []) as ActiveYieldSizeWithId[];
    const varietyByName = new Map(activeVarieties.map((v) => [v.name, v]));

    // Parse all PDFs in parallel first
    const parsedFiles = await Promise.all(
      uploadedFiles.map(async (file) => {
        try {
          const parsed = await parseFlowMasterPdfBuffer(file.buffer, file.originalname);
          return { filename: file.originalname, parsed, parseError: null as null };
        } catch (err) {
          return {
            filename: file.originalname,
            parsed: null,
            parseError: err instanceof Error ? err.message : "Failed to parse PDF."
          };
        }
      })
    );

    // Batch-check already-imported lots against import history
    const uploadedLots = parsedFiles
      .map((f) => f.parsed?.lotNumber)
      .filter((n): n is string => typeof n === "string" && n.length > 0);

    const alreadyImportedLots = new Set<string>();

    if (uploadedLots.length > 0) {
      const { data: importRuns } = await supabase
        .from("yield_import_runs")
        .select("lot_number")
        .eq("organization_id", organizationId)
        .in("lot_number", uploadedLots);

      for (const run of (importRuns ?? []) as { lot_number: string }[]) {
        alreadyImportedLots.add(run.lot_number);
      }
    }

    const results: FileResult[] = [];
    const seenLotsInBatch = new Set<string>();

    for (const file of parsedFiles) {
      if (!file.parsed) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: file.parseError ?? "Failed to parse PDF."
        });
        continue;
      }

      const parsed = file.parsed;

      if (!parsed.lotNumber) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: "Could not extract lot number from PDF."
        });
        continue;
      }

      if (alreadyImportedLots.has(parsed.lotNumber)) {
        results.push({
          filename: file.filename,
          status: "skipped",
          reason: "already_imported",
          lotNumber: parsed.lotNumber
        });
        continue;
      }

      if (seenLotsInBatch.has(parsed.lotNumber)) {
        results.push({
          filename: file.filename,
          status: "skipped",
          reason: "duplicate_in_batch",
          lotNumber: parsed.lotNumber
        });
        continue;
      }

      seenLotsInBatch.add(parsed.lotNumber);

      if (!parsed.varietyName) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: "Could not extract variety name from PDF."
        });
        continue;
      }

      const variety = varietyByName.get(parsed.varietyName);
      if (!variety) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: `Variety not found: ${parsed.varietyName}. Add or rename variety before importing.`
        });
        continue;
      }

      if (parsed.isoYear === null || parsed.isoWeek === null) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: "Could not determine ISO year/week from PDF start time."
        });
        continue;
      }

      let sizeKgById: Record<string, number>;
      try {
        sizeKgById = mapSizeNamesToIds(parsed.sizeKg, activeSizes);
      } catch (err) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: err instanceof Error ? err.message : "Size mapping failed."
        });
        continue;
      }

      const varietyForCalc: VarietyForCalc = {
        id: variety.id,
        area_m2: variety.area_m2,
        case_kg: variety.case_kg
      };

      const { data: existingEntries, error: existingError } = await supabase
        .from("yield_entries")
        .select("id, size_kg, average_fruit_weight_g")
        .eq("organization_id", organizationId)
        .eq("variety_id", variety.id)
        .eq("year", parsed.isoYear)
        .eq("week", parsed.isoWeek);

      if (existingError) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: "Failed to check existing entries."
        });
        continue;
      }

      const startTimeIso = parseFlowMasterStartTimeToIso(parsed.startTime);

      if ((existingEntries ?? []).length === 0) {
        // Create
        const totals = calculateTotals(sizeKgById, varietyForCalc);

        const { error: insertError } = await supabase.from("yield_entries").insert({
          organization_id: organizationId,
          variety_id: variety.id,
          year: parsed.isoYear,
          week: parsed.isoWeek,
          size_kg: sizeKgById,
          average_fruit_weight_g: parsed.averageFruitWeightG,
          ...totals
        });

        if (insertError) {
          results.push({
            filename: file.filename,
            status: "error",
            reason: "Failed to create yield entry."
          });
          continue;
        }

        const { error: runInsertError } = await supabase
          .from("yield_import_runs")
          .insert({
            organization_id: organizationId,
            lot_number: parsed.lotNumber,
            variety_id: variety.id,
            iso_year: parsed.isoYear,
            iso_week: parsed.isoWeek,
            start_time: startTimeIso,
            source_filename: file.filename,
            created_by: null
          });

        if (runInsertError) {
          results.push({
            filename: file.filename,
            status: "error",
            reason: "Failed to record import run."
          });
          continue;
        }

        results.push({
          filename: file.filename,
          status: "imported",
          mode: "create",
          lotNumber: parsed.lotNumber,
          varietyName: variety.name,
          isoYear: parsed.isoYear,
          isoWeek: parsed.isoWeek,
          totalKg: totals.total_kg
        });
      } else if ((existingEntries ?? []).length === 1) {
        // Append
        const existingEntry = existingEntries[0] as {
          id: string;
          size_kg: Record<string, unknown> | null;
          average_fruit_weight_g: number | null;
        };

        const existingSizeKg: Record<string, number> = {};
        for (const [sizeId, rawKg] of Object.entries(existingEntry.size_kg ?? {})) {
          const kg = typeof rawKg === "number" ? rawKg : Number(rawKg);
          if (Number.isFinite(kg) && kg >= 0) existingSizeKg[sizeId] = kg;
        }

        const mergedSizeKg: Record<string, number> = { ...existingSizeKg };
        for (const [sizeId, incomingKg] of Object.entries(sizeKgById)) {
          mergedSizeKg[sizeId] = (mergedSizeKg[sizeId] ?? 0) + incomingKg;
        }

        const existingTotalKg = Object.values(existingSizeKg).reduce(
          (s, k) => s + k,
          0
        );
        const incomingTotalKg = Object.values(sizeKgById).reduce((s, k) => s + k, 0);
        const weightedDenominator =
          (existingEntry.average_fruit_weight_g !== null ? existingTotalKg : 0) +
          (parsed.averageFruitWeightG !== null ? incomingTotalKg : 0);

        const mergedAvg =
          weightedDenominator > 0
            ? ((existingEntry.average_fruit_weight_g !== null
                ? existingEntry.average_fruit_weight_g * existingTotalKg
                : 0) +
                (parsed.averageFruitWeightG !== null
                  ? parsed.averageFruitWeightG * incomingTotalKg
                  : 0)) /
              weightedDenominator
            : null;

        const mergedTotals = calculateTotals(mergedSizeKg, varietyForCalc);

        const { error: updateError } = await supabase
          .from("yield_entries")
          .update({
            size_kg: mergedSizeKg,
            average_fruit_weight_g: mergedAvg,
            ...mergedTotals,
            updated_at: new Date().toISOString()
          })
          .eq("id", existingEntry.id)
          .eq("organization_id", organizationId);

        if (updateError) {
          results.push({
            filename: file.filename,
            status: "error",
            reason: "Failed to append to yield entry."
          });
          continue;
        }

        const { error: runInsertError } = await supabase
          .from("yield_import_runs")
          .insert({
            organization_id: organizationId,
            lot_number: parsed.lotNumber,
            variety_id: variety.id,
            iso_year: parsed.isoYear,
            iso_week: parsed.isoWeek,
            start_time: startTimeIso,
            source_filename: file.filename,
            created_by: null
          });

        if (runInsertError) {
          results.push({
            filename: file.filename,
            status: "error",
            reason: "Failed to record import run."
          });
          continue;
        }

        results.push({
          filename: file.filename,
          status: "imported",
          mode: "append",
          lotNumber: parsed.lotNumber,
          varietyName: variety.name,
          isoYear: parsed.isoYear,
          isoWeek: parsed.isoWeek,
          totalKg: mergedTotals.total_kg
        });
      } else {
        results.push({
          filename: file.filename,
          status: "error",
          reason:
            "Multiple weekly entries exist for this variety/week. Resolve duplicates before importing."
        });
      }
    }

    const importedCount = results.filter((r) => r.status === "imported").length;
    const skippedCount = results.filter((r) => r.status === "skipped").length;
    const errorCount = results.filter((r) => r.status === "error").length;

    return res.json({
      success: true,
      summary: { imported: importedCount, skipped: skippedCount, errors: errorCount },
      results
    });
  });
});

export { agentRouter };
