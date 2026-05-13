import multer from "multer";
import { Request, Response, Router } from "express";
import { supabase } from "../config/supabase";
import { requireUploadKey } from "../middleware/requireUploadKey";
import { parseFlowMasterPdfBuffer } from "../utils/flowMasterPdfParser";
import {
  parseFlowMasterStartTimeToIso,
  calculateTotals,
  mapSizeNamesToIds,
  canonicalizeSizeName,
  type ActiveYieldSizeWithId,
  type VarietyForCalc,
  type SizeMappingResult
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
        console.warn("[agent/pdf-import] variety not matched", {
          organizationId,
          lotNumber: parsed.lotNumber,
          pdfVarietyName: parsed.varietyName
        });
        results.push({
          filename: file.filename,
          status: "error",
          reason: `Variety not found: ${parsed.varietyName}. Add or rename variety before importing.`
        });
        continue;
      }

      console.log("[agent/pdf-import] variety matched", {
        organizationId,
        lotNumber: parsed.lotNumber,
        varietyId: variety.id,
        varietyName: variety.name
      });

      if (parsed.isoYear === null || parsed.isoWeek === null) {
        console.warn("[agent/pdf-import] could not determine iso year/week", {
          organizationId,
          lotNumber: parsed.lotNumber,
          startTime: parsed.startTime
        });
        results.push({
          filename: file.filename,
          status: "error",
          reason: "Could not determine ISO year/week from PDF start time."
        });
        continue;
      }

      const availableCanonical = activeSizes.map((s) => canonicalizeSizeName(s.name));

      for (const pdfLabel of Object.keys(parsed.sizeKg)) {
        console.log("[agent/pdf-import] size normalized", {
          organizationId,
          lotNumber: parsed.lotNumber,
          pdfLabel,
          canonicalLabel: canonicalizeSizeName(pdfLabel)
        });
      }

      const { mapped: sizeKgById, matched: sizeMatched, skipped: sizeSkipped }: SizeMappingResult =
        mapSizeNamesToIds(parsed.sizeKg, activeSizes);

      for (const m of sizeMatched) {
        console.log("[agent/pdf-import] size matched", {
          organizationId,
          lotNumber: parsed.lotNumber,
          pdfLabel: m.pdfLabel,
          canonicalLabel: m.canonicalLabel,
          sizeId: m.sizeId,
          sizeName: m.sizeName
        });
      }

      for (const s of sizeSkipped) {
        console.warn("[agent/pdf-import] unknown size skipped", {
          organizationId,
          lotNumber: parsed.lotNumber,
          pdfLabel: s.pdfLabel,
          canonicalLabel: s.canonicalLabel,
          availableCanonical
        });
      }

      if (Object.keys(sizeKgById).length === 0) {
        const pdfLabels = sizeSkipped.map((s) => s.pdfLabel).join(", ");
        results.push({
          filename: file.filename,
          status: "error",
          reason: `No sizes could be matched to active sizes. PDF sizes: ${pdfLabels || "none"}.`
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
        console.error("[agent/pdf-import] existing yield_entries lookup failed", {
          organizationId,
          lotNumber: parsed.lotNumber,
          varietyId: variety.id,
          isoYear: parsed.isoYear,
          isoWeek: parsed.isoWeek,
          code: existingError.code,
          message: existingError.message,
          details: existingError.details,
          hint: existingError.hint
        });
        results.push({
          filename: file.filename,
          status: "error",
          reason: "Failed to check existing entries."
        });
        continue;
      }

      const startTimeIso = parseFlowMasterStartTimeToIso(parsed.startTime);

      console.log("[agent/pdf-import] processing lot", {
        organizationId,
        lotNumber: parsed.lotNumber,
        varietyId: variety.id,
        varietyName: variety.name,
        isoYear: parsed.isoYear,
        isoWeek: parsed.isoWeek,
        existingEntryCount: (existingEntries ?? []).length
      });

      if ((existingEntries ?? []).length === 0) {
        // Create
        const totals = calculateTotals(sizeKgById, varietyForCalc);

        console.log("[agent/pdf-import] inserting new yield_entry", {
          organizationId,
          lotNumber: parsed.lotNumber,
          varietyId: variety.id,
          varietyName: variety.name,
          isoYear: parsed.isoYear,
          isoWeek: parsed.isoWeek,
          totalKg: totals.total_kg
        });

        const { data: insertedEntry, error: insertError } = await supabase
          .from("yield_entries")
          .insert({
            organization_id: organizationId,
            variety_id: variety.id,
            year: parsed.isoYear,
            week: parsed.isoWeek,
            size_kg: sizeKgById,
            average_fruit_weight_g: parsed.averageFruitWeightG,
            ...totals
          })
          .select("id")
          .single();

        if (insertError || !insertedEntry) {
          console.error("[agent/pdf-import] yield_entry insert failed", {
            organizationId,
            lotNumber: parsed.lotNumber,
            varietyId: variety.id,
            isoYear: parsed.isoYear,
            isoWeek: parsed.isoWeek,
            code: insertError?.code,
            message: insertError?.message,
            details: insertError?.details,
            hint: insertError?.hint
          });
          results.push({
            filename: file.filename,
            status: "error",
            reason: "Failed to create yield entry."
          });
          continue;
        }

        console.log("[agent/pdf-import] yield_entry created", {
          entryId: insertedEntry.id,
          organizationId,
          lotNumber: parsed.lotNumber,
          varietyId: variety.id,
          varietyName: variety.name,
          isoYear: parsed.isoYear,
          isoWeek: parsed.isoWeek,
          totalKg: totals.total_kg
        });

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
          console.error("[agent/pdf-import] yield_import_runs insert failed after yield_entry create", {
            organizationId,
            lotNumber: parsed.lotNumber,
            entryId: insertedEntry.id,
            code: runInsertError.code,
            message: runInsertError.message,
            details: runInsertError.details,
            hint: runInsertError.hint
          });
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

        console.log("[agent/pdf-import] appending to existing yield_entry", {
          entryId: existingEntry.id,
          organizationId,
          lotNumber: parsed.lotNumber,
          varietyId: variety.id,
          varietyName: variety.name,
          isoYear: parsed.isoYear,
          isoWeek: parsed.isoWeek,
          existingTotalKg,
          incomingTotalKg,
          mergedTotalKg: mergedTotals.total_kg
        });

        const { data: updatedEntry, error: updateError } = await supabase
          .from("yield_entries")
          .update({
            size_kg: mergedSizeKg,
            average_fruit_weight_g: mergedAvg,
            ...mergedTotals,
            updated_at: new Date().toISOString()
          })
          .eq("id", existingEntry.id)
          .eq("organization_id", organizationId)
          .select("id")
          .single();

        if (updateError || !updatedEntry) {
          console.error("[agent/pdf-import] yield_entry update failed", {
            entryId: existingEntry.id,
            organizationId,
            lotNumber: parsed.lotNumber,
            varietyId: variety.id,
            isoYear: parsed.isoYear,
            isoWeek: parsed.isoWeek,
            code: updateError?.code,
            message: updateError?.message,
            details: updateError?.details,
            hint: updateError?.hint
          });
          results.push({
            filename: file.filename,
            status: "error",
            reason: "Failed to append to yield entry."
          });
          continue;
        }

        console.log("[agent/pdf-import] yield_entry updated", {
          entryId: updatedEntry.id,
          organizationId,
          lotNumber: parsed.lotNumber,
          varietyId: variety.id,
          varietyName: variety.name,
          isoYear: parsed.isoYear,
          isoWeek: parsed.isoWeek,
          mergedTotalKg: mergedTotals.total_kg
        });

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
          console.error("[agent/pdf-import] yield_import_runs insert failed after yield_entry update", {
            organizationId,
            lotNumber: parsed.lotNumber,
            entryId: updatedEntry.id,
            code: runInsertError.code,
            message: runInsertError.message,
            details: runInsertError.details,
            hint: runInsertError.hint
          });
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
        console.warn("[agent/pdf-import] multiple existing entries found, skipping", {
          organizationId,
          lotNumber: parsed.lotNumber,
          varietyId: variety.id,
          isoYear: parsed.isoYear,
          isoWeek: parsed.isoWeek,
          existingEntryCount: (existingEntries ?? []).length
        });
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
