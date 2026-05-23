import multer from "multer";
import { Request, Response, Router } from "express";
import { supabase } from "../config/supabase";
import { requireUploadKey } from "../middleware/requireUploadKey";
import { parseFlowMasterPdfBuffer, type FlowMasterParseResult } from "../utils/flowMasterPdfParser";
import { parseFlowMasterCsvBuffer } from "../utils/flowMasterCsvParser";

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
    const isCsv =
      file.mimetype === "text/csv" ||
      file.mimetype === "application/csv" ||
      /\.csv$/i.test(file.originalname);
    if (isPdf || isCsv) {
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
      status: "queued";
      lotNumber: string;
    }
  | {
      filename: string;
      status: "skipped";
      reason: "already_imported" | "duplicate_in_batch";
      lotNumber: string;
    }
  | { filename: string; status: "error"; reason: string };

// POST /api/agent/pdf-import
// Accepts multipart PDFs/CSVs, parses each run, and queues them in
// agent_pending_imports for manual review in Yield Data Entry.
// Lots already present in yield_import_runs (completed imports) are skipped.
agentRouter.post("/agent/pdf-import", requireUploadKey, (req: Request, res: Response) => {
  upload.array("files", MAX_FILES_PER_REQUEST)(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError) {
        if (uploadError.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ message: "Each file must be 15MB or smaller." });
        }
        if (uploadError.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({
            message: `You can upload up to ${MAX_FILES_PER_REQUEST} files at once.`
          });
        }
        return res.status(400).json({ message: "Only PDF and CSV files are allowed." });
      }
      console.error("[agent/pdf-import] upload error:", uploadError);
      return res.status(500).json({ message: "Failed to process upload." });
    }

    const uploadedFiles = Array.isArray(req.files)
      ? (req.files as Express.Multer.File[])
      : [];

    if (uploadedFiles.length === 0) {
      return res.status(400).json({ message: "Please upload at least one file." });
    }

    const organizationId = req.organizationId;
    const uploadKeyLabel = req.uploadKeyLabel ?? null;

    // Parse all files in parallel; CSVs may fan into multiple runs per file.
    type ParsedEntry = { filename: string; parsed: FlowMasterParseResult | null; parseError: string | null };
    const fileParseArrays = await Promise.all(
      uploadedFiles.map(async (file): Promise<ParsedEntry[]> => {
        const isCsv =
          /\.csv$/i.test(file.originalname) ||
          file.mimetype === "text/csv" ||
          file.mimetype === "application/csv";
        try {
          if (isCsv) {
            const csvResults = parseFlowMasterCsvBuffer(file.buffer, file.originalname);
            if (csvResults.length === 0) {
              return [{ filename: file.originalname, parsed: null, parseError: "CSV contained no importable runs." }];
            }
            return csvResults.map((parsed) => ({ filename: file.originalname, parsed, parseError: null as null }));
          }
          const parsed = await parseFlowMasterPdfBuffer(file.buffer, file.originalname);
          return [{ filename: file.originalname, parsed, parseError: null as null }];
        } catch (err) {
          return [{
            filename: file.originalname,
            parsed: null,
            parseError: err instanceof Error ? err.message : "Failed to parse file."
          }];
        }
      })
    );
    const parsedFiles = fileParseArrays.flat();

    // Batch-check already-imported lots against yield_import_runs.
    // Lots present there are fully imported and must not be re-queued.
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
      // Parse failure.
      if (!file.parsed) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: file.parseError ?? "Failed to parse file."
        });
        continue;
      }

      const parsed = file.parsed;

      // Lot number is required as the unique key.
      if (!parsed.lotNumber) {
        results.push({
          filename: file.filename,
          status: "error",
          reason: "Could not extract lot number from file."
        });
        continue;
      }

      // Already in yield_import_runs → fully imported, skip.
      if (alreadyImportedLots.has(parsed.lotNumber)) {
        results.push({
          filename: file.filename,
          status: "skipped",
          reason: "already_imported",
          lotNumber: parsed.lotNumber
        });
        continue;
      }

      // Duplicate lot within this batch → skip the later occurrence.
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

      // Upsert into agent_pending_imports.
      // ON CONFLICT (organization_id, lot_number): overwrite with the freshest parsed data.
      const { error: upsertError } = await supabase
        .from("agent_pending_imports")
        .upsert(
          {
            organization_id: organizationId,
            lot_number: parsed.lotNumber,
            variety_name: parsed.varietyName,
            source_filename: file.filename,
            start_time: parsed.startTime,
            iso_year: parsed.isoYear,
            iso_week: parsed.isoWeek,
            average_fruit_weight_g: parsed.averageFruitWeightG,
            size_kg: parsed.sizeKg,
            parsed_total_kg: parsed.totalKg,
            warnings: parsed.warnings,
            unknown_sizes: parsed.unknownSizes,
            upload_key_label: uploadKeyLabel,
            source_type: "agent",
            raw_payload: parsed,
            uploaded_at: new Date().toISOString()
          },
          { onConflict: "organization_id,lot_number" }
        );

      if (upsertError) {
        console.error("[agent/pdf-import] pending import upsert failed", {
          organizationId,
          lotNumber: parsed.lotNumber,
          code: upsertError.code,
          message: upsertError.message,
          details: upsertError.details,
          hint: upsertError.hint
        });
        results.push({
          filename: file.filename,
          status: "error",
          reason: "Failed to queue import for review."
        });
        continue;
      }

      console.log("[agent/pdf-import] queued for review", {
        organizationId,
        lotNumber: parsed.lotNumber,
        varietyName: parsed.varietyName,
        isoYear: parsed.isoYear,
        isoWeek: parsed.isoWeek,
        sourceFilename: file.filename
      });

      results.push({
        filename: file.filename,
        status: "queued",
        lotNumber: parsed.lotNumber
      });
    }

    const queuedCount = results.filter((r) => r.status === "queued").length;
    const skippedCount = results.filter((r) => r.status === "skipped").length;
    const errorCount = results.filter((r) => r.status === "error").length;

    return res.json({
      success: true,
      summary: { queued: queuedCount, skipped: skippedCount, errors: errorCount },
      results
    });
  });
});

export { agentRouter };
