import { createHash } from "crypto";
import multer from "multer";
import { Request, Response, Router } from "express";
import { supabase } from "../config/supabase";
import { requireUploadKey } from "../middleware/requireUploadKey";
import { isPdfBuffer } from "../utils/detectFileType";
import { parseFlowMasterPdfBuffer, type FlowMasterParseResult } from "../utils/flowMasterPdfParser";
import { parseFlowMasterCsvBuffer } from "../utils/flowMasterCsvParser";
import { fetchCsvSizeSettings } from "../utils/csvSizeSettings";
import {
  parseGenericCsvBuffer,
  extractCsvHeaders,
  type ColumnMappings,
} from "../utils/genericCsvParser";
import {
  parseWeatherStationCsv,
  type WeatherStationMappings,
} from "../utils/weatherStationCsvParser";
import {
  parseAndMatchCsvFile,
  buildCsvPreview,
  createPendingCsvTemplateImport,
} from "./csvMappingTemplates";

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
  | { filename: string; status: "queued"; lotNumber: string }
  | { filename: string; status: "pending_template" }
  | { filename: string; status: "imported"; importId: string }
  | {
      filename: string;
      status: "skipped";
      reason: "already_imported" | "duplicate_in_batch";
      lotNumber: string;
    }
  | { filename: string; status: "error"; reason: string }
  // csv_template key outcomes (see the csv_template branch below):
  | {
      filename: string;
      status: "csv_template_queued";
      pendingImportId: string;
      templateId: string;
      templateName: string | null;
    }
  | {
      filename: string;
      status: "csv_template_needs_template";
      pendingImportId: string;
      matchKind: "close" | "none";
    }
  | {
      filename: string;
      status: "duplicate";
      accepted: true;
      duplicate: true;
      pendingImportId: string | null;
      importRunId: string | null;
    };


// A NUL byte in the first 512 bytes is a strong, cheap signal that a file
// is not text at all (a mislabeled binary, not a CSV) — this is the "do
// not trust filename extension alone" content check for the CSV side of
// the csv_template branch, on top of the existing multer fileFilter.
function looksLikeBinaryGarbage(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, 512);
  for (let i = 0; i < probeLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// Mirrors the essential per-file logic of the "flowmaster path" further
// below (parse -> dedup check against yield_import_runs -> upsert into
// agent_pending_imports) for exactly one PDF file, so a csv_template key's
// PDFs get identical treatment to a flowmaster key's PDFs. Deliberately a
// separate, independent implementation rather than an extraction from the
// pinned flowmaster block — this function can be added without touching
// (and risking) that already-tested code path.
async function processCsvTemplateKeyPdfFile(
  file: Express.Multer.File,
  organizationId: string,
  uploadKeyLabel: string | null,
  uploadKeyId: string | null
): Promise<FileResult> {
  let parsed: FlowMasterParseResult;
  try {
    parsed = await parseFlowMasterPdfBuffer(file.buffer, file.originalname);
  } catch (err) {
    return {
      filename: file.originalname,
      status: "error",
      reason: err instanceof Error ? err.message : "Failed to parse PDF file.",
    };
  }

  if (!parsed.lotNumber) {
    return { filename: file.originalname, status: "error", reason: "Could not extract lot number from file." };
  }

  const { data: existingRun } = await supabase
    .from("yield_import_runs")
    .select("lot_number")
    .eq("organization_id", organizationId)
    .eq("lot_number", parsed.lotNumber)
    .maybeSingle();

  if (existingRun) {
    return { filename: file.originalname, status: "skipped", reason: "already_imported", lotNumber: parsed.lotNumber };
  }

  const { error: upsertError } = await supabase.from("agent_pending_imports").upsert(
    {
      organization_id: organizationId,
      lot_number: parsed.lotNumber,
      variety_name: parsed.varietyName,
      source_filename: file.originalname,
      start_time: parsed.startTime,
      iso_year: parsed.isoYear,
      iso_week: parsed.isoWeek,
      average_fruit_weight_g: parsed.averageFruitWeightG,
      size_kg: parsed.sizeKg,
      parsed_total_kg: parsed.totalKg,
      warnings: parsed.warnings,
      unknown_sizes: parsed.unknownSizes,
      upload_key_label: uploadKeyLabel,
      upload_key_id: uploadKeyId,
      data_source_type: "flowmaster",
      source_type: "agent",
      needs_template: false,
      raw_payload: parsed,
      uploaded_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,lot_number" }
  );

  if (upsertError) {
    console.error("[agent/pdf-import] csv_template-key PDF upsert failed", {
      organizationId,
      lotNumber: parsed.lotNumber,
      code: upsertError.code,
      message: upsertError.message,
    });
    return { filename: file.originalname, status: "error", reason: "Failed to queue import for review." };
  }

  return { filename: file.originalname, status: "queued", lotNumber: parsed.lotNumber };
}

// Mirrors the essential per-file logic of the csv_template branch below for
// exactly one CSV file. Extracted (pure code-move, no behavior change) so
// the idempotency check — "a hard-deleted pending row must be recreated on
// resend, unless the lot was already imported" — is directly unit-testable
// against the real database without needing the Agent's upload-key secret
// to drive it through HTTP.
async function processCsvTemplateKeyCsvFile(
  file: Express.Multer.File,
  organizationId: string
): Promise<FileResult> {
  let matchResult: Awaited<ReturnType<typeof parseAndMatchCsvFile>>;
  try {
    matchResult = await parseAndMatchCsvFile(organizationId, null, file);
  } catch (err) {
    console.error("[agent/pdf-import] csv_template parse/match failed", {
      organizationId,
      filename: file.originalname,
      error: err instanceof Error ? err.message : err,
    });
    return {
      filename: file.originalname,
      status: "error",
      reason: err instanceof Error ? err.message : "Failed to process CSV file.",
    };
  }

  if (matchResult.rowCount === 0) {
    return { filename: file.originalname, status: "error", reason: "CSV file is empty." };
  }

  // Idempotency: the same organization + content hash always resolves
  // to the same source_file_id (parseAndMatchCsvFile dedupes on
  // insert). If that source has already produced a pending review row
  // or a completed import, never create a second one — acknowledge
  // and let the Agent archive the file under Uploaded as normal. A row
  // that was hard-deleted (e.g. dismissed from the Pending CSV Imports
  // review queue) no longer matches either query, so a resend of the
  // identical file correctly falls through to re-queue it below.
  const [{ data: existingPendingRows }, { data: existingRunRows }] = await Promise.all([
    supabase
      .from("agent_pending_imports")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("source_file_id", matchResult.sourceFileId)
      .limit(1),
    supabase
      .from("yield_import_runs")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("source_file_id", matchResult.sourceFileId)
      .limit(1),
  ]);

  const existingPendingId = existingPendingRows?.[0]?.id as string | undefined;
  const existingRunId = existingRunRows?.[0]?.id as string | undefined;

  if (existingPendingId || existingRunId) {
    return {
      filename: file.originalname,
      status: "duplicate",
      accepted: true,
      duplicate: true,
      pendingImportId: existingPendingId ?? null,
      importRunId: existingRunId ?? null,
    };
  }

  if (matchResult.match.kind === "exact" && matchResult.match.templateId) {
    // Run complete server-side validation/reconciliation before
    // ever queuing this for review — a template that throws while
    // processing this specific file is treated as unsafe, not
    // silently queued for a human to discover later.
    try {
      await buildCsvPreview(organizationId, {
        sourceFileId: matchResult.sourceFileId,
        templateId: matchResult.match.templateId,
      });
    } catch (err) {
      console.error("[agent/pdf-import] csv_template matched-template preview failed", {
        organizationId,
        filename: file.originalname,
        templateId: matchResult.match.templateId,
        error: err instanceof Error ? err.message : err,
      });
      return {
        filename: file.originalname,
        status: "error",
        reason: "Matched template failed to process this file safely.",
      };
    }

    const pending = await createPendingCsvTemplateImport(
      organizationId,
      matchResult.sourceFileId,
      file.originalname,
      matchResult.match.templateId,
      false
    );

    return {
      filename: file.originalname,
      status: "csv_template_queued",
      pendingImportId: pending.id,
      templateId: matchResult.match.templateId,
      templateName: matchResult.match.templateName,
    };
  }

  // Close match or no match at all — never fall back to the
  // hard-coded FlowMaster CSV parser. Preserve the raw source and
  // surface it for template setup; nothing is auto-imported.
  const pending = await createPendingCsvTemplateImport(
    organizationId,
    matchResult.sourceFileId,
    file.originalname,
    null,
    true
  );

  return {
    filename: file.originalname,
    status: "csv_template_needs_template",
    pendingImportId: pending.id,
    matchKind: matchResult.match.kind === "close" ? "close" : "none",
  };
}

// POST /api/agent/pdf-import
// Accepts multipart PDFs/CSVs. Routing by data_source_type:
//   flowmaster    → existing FlowMaster PDF/CSV parsers (unchanged)
//   generic_csv   → template-driven CSV parser; if no template is saved yet,
//                   stores raw CSV and marks as needs_template=true
//   csv_template  → generic CSV Import Template Builder (structural
//                   fingerprint match against the org's saved templates);
//                   PDFs still go through the FlowMaster PDF parser above
agentRouter.post("/agent/pdf-import", requireUploadKey, (req: Request, res: Response) => {
  // Absolute-earliest log — fires before multer, before any branching.
  console.log("[agent/pdf-import] route hit", {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    organizationId: req.organizationId,
    uploadKeyId: req.uploadKeyId,
    dataSourceType: req.dataSourceType,
    fileCount: Array.isArray(req.files) ? req.files.length : "(pre-multer)",
    contentType: req.headers["content-type"],
  });

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
    const uploadKeyId = req.uploadKeyId ?? null;
    const dataSourceType = req.dataSourceType ?? "flowmaster";

    if (dataSourceType !== "flowmaster" && dataSourceType !== "generic_csv" && dataSourceType !== "csv_template") {
      return res.status(400).json({
        message: `Unsupported data source type: ${dataSourceType}. Contact GrowLink support.`
      });
    }

    // ── generic_csv path ──────────────────────────────────────────────────────
    if (dataSourceType === "generic_csv") {
      console.log("[agent/pdf-import] generic_csv entry", {
        organizationId,
        uploadKeyId,
        uploadKeyLabel,
        fileCount: uploadedFiles.length,
        filenames: uploadedFiles.map((f) => f.originalname),
      });

      // Look up the saved template for this upload key.
      const { data: templateRow, error: templateError } = await supabase
        .from("import_source_templates")
        .select("column_mappings, import_type")
        .eq("upload_key_id", uploadKeyId)
        .maybeSingle();

      if (templateError) {
        console.error("[agent/pdf-import] template lookup failed — migration 0065 may not be applied", {
          organizationId,
          uploadKeyId,
          code: templateError.code,
          message: templateError.message,
        });
        return res.status(500).json({
          message: "Failed to load import template. Check that migration 0065 has been applied.",
          detail: templateError.message,
        });
      }

      const columnMappings = templateRow?.column_mappings as ColumnMappings | null;
      const templateImportType = (templateRow?.import_type as string | null) ?? "yield_kg";

      console.log("[agent/pdf-import] template resolved", {
        organizationId,
        uploadKeyId,
        templateFound: templateRow !== null,
        templateImportType,
        hasMappings: !!columnMappings,
      });

      const results: FileResult[] = [];

      for (const file of uploadedFiles) {
        const isCsv =
          /\.csv$/i.test(file.originalname) ||
          file.mimetype === "text/csv" ||
          file.mimetype === "application/csv";

        if (!isCsv) {
          results.push({
            filename: file.originalname,
            status: "error",
            reason:
              "Non-CSV files are not supported for generic CSV import keys. Only .csv files are accepted.",
          });
          continue;
        }

        if (!columnMappings) {
          // No template yet (or template query failed) — store raw CSV so admin can configure.
          console.warn("[agent/pdf-import] no columnMappings — routing to needs_template", {
            organizationId,
            uploadKeyId,
            filename: file.originalname,
            templateFound: templateRow !== null,
            templateImportType,
          });
          let headers: string[] = [];
          try {
            headers = extractCsvHeaders(file.buffer);
          } catch {
            // Non-fatal: headers are best-effort for the UI preview.
          }

          const { error: insertError } = await supabase
            .from("agent_pending_imports")
            .insert({
              organization_id: organizationId,
              lot_number: null,
              variety_name: null,
              source_filename: file.originalname,
              size_kg: {},
              parsed_total_kg: null,
              warnings: [
                "No import template configured for this upload key. " +
                  "Open GrowLink Admin → Agent → configure the import mapping to process this file.",
              ],
              unknown_sizes: [],
              upload_key_label: uploadKeyLabel,
              upload_key_id: uploadKeyId,
              data_source_type: "generic_csv",
              source_type: "agent",
              needs_template: true,
              raw_payload: {
                csv_text: file.buffer.toString("utf-8"),
                csv_headers: headers,
              },
              uploaded_at: new Date().toISOString(),
            });

          if (insertError) {
            console.error("[agent/pdf-import] needs_template insert failed", {
              organizationId,
              filename: file.originalname,
              code: insertError.code,
              message: insertError.message,
            });
            results.push({ filename: file.originalname, status: "error", reason: "Failed to store file for configuration." });
          } else {
            results.push({ filename: file.originalname, status: "pending_template" });
          }
          continue;
        }

        // Template exists — dispatch by import type.

        // ── weather_station: write directly to climate tables ─────────────────
        if (templateImportType === "weather_station") {
          const wsMappings = columnMappings as unknown as WeatherStationMappings;
          try {
            const parsed = parseWeatherStationCsv(file.buffer, file.originalname, wsMappings);

            console.log("[agent/pdf-import] weather_station parsed", {
              organizationId,
              filename: file.originalname,
              exportTimestamp: parsed.exportTimestamp,
              logDate: parsed.exportTimestamp.slice(0, 10),
              stationName: parsed.stationName,
              fileHash: parsed.fileHash,
              readingCount: parsed.readings.length,
              readings: parsed.readings.map((r) => ({ metric: r.metric_name, value: r.metric_value, unit: r.unit })),
            });

            // Dedup against climate_imports.
            const { data: existing } = await supabase
              .from("climate_imports")
              .select("id")
              .eq("organization_id", organizationId)
              .eq("file_hash", parsed.fileHash)
              .maybeSingle();

            if (existing) {
              console.log("[agent/pdf-import] weather_station skipped — already imported", {
                organizationId,
                filename: file.originalname,
                exportTimestamp: parsed.exportTimestamp,
                existingImportId: existing.id,
              });
              results.push({
                filename: file.originalname,
                status: "skipped",
                reason: "already_imported",
                lotNumber: parsed.exportTimestamp,
              });
              continue;
            }

            const { data: insertedImport, error: importInsertError } = await supabase
              .from("climate_imports")
              .insert({
                organization_id: organizationId,
                source_file: file.originalname,
                file_type: "weather_station",
                export_timestamp: parsed.exportTimestamp,
                file_hash: parsed.fileHash,
                row_count: parsed.readings.length,
                upload_key_label: uploadKeyLabel,
              })
              .select("id")
              .single();

            console.log("[agent/pdf-import] climate_imports insert", {
              organizationId,
              filename: file.originalname,
              insertedId: insertedImport?.id ?? null,
              error: importInsertError ? { code: importInsertError.code, message: importInsertError.message } : null,
            });

            if (importInsertError || !insertedImport) {
              console.error("[agent/pdf-import] weather_station climate_imports insert failed", {
                organizationId,
                filename: file.originalname,
                code: importInsertError?.code,
                message: importInsertError?.message,
              });
              results.push({ filename: file.originalname, status: "error", reason: "Failed to record climate import." });
              continue;
            }

            const importId = insertedImport.id as string;

            if (parsed.readings.length > 0) {
              const readingRows = parsed.readings.map((r) => ({
                organization_id: organizationId,
                import_id: importId,
                timestamp: parsed.exportTimestamp,
                zone_label: r.zone_label,
                metric_name: r.metric_name,
                metric_value: r.metric_value,
                unit: r.unit,
                source_file: file.originalname,
              }));

              const { error: readingsError } = await supabase
                .from("climate_readings")
                .upsert(readingRows, {
                  onConflict: "organization_id,timestamp,zone_key,metric_name",
                  ignoreDuplicates: true,
                });

              console.log("[agent/pdf-import] climate_readings upsert", {
                organizationId,
                filename: file.originalname,
                rowCount: readingRows.length,
                error: readingsError ? { code: readingsError.code, message: readingsError.message } : null,
              });

              if (readingsError) {
                console.error("[agent/pdf-import] weather_station climate_readings upsert failed", {
                  organizationId,
                  filename: file.originalname,
                  code: readingsError.code,
                  message: readingsError.message,
                });
                results.push({ filename: file.originalname, status: "error", reason: "Failed to write climate readings." });
                continue;
              }

              const radiationReadings = parsed.readings.filter(
                (r) => r.metric_name === "radiation_sum"
              );
              if (radiationReadings.length > 0) {
                const total = radiationReadings.reduce((s, r) => s + r.metric_value, 0);
                const { error: dllError } = await supabase
                  .from("daily_light_logs")
                  .upsert(
                    {
                      organization_id: organizationId,
                      log_date: parsed.exportTimestamp.slice(0, 10),
                      joules_per_cm2: total,
                      source: "climate_agent",
                      updated_at: new Date().toISOString(),
                    },
                    { onConflict: "organization_id,log_date" }
                  );

                console.log("[agent/pdf-import] daily_light_logs upsert", {
                  organizationId,
                  filename: file.originalname,
                  logDate: parsed.exportTimestamp.slice(0, 10),
                  joulesPerCm2: total,
                  error: dllError ? { code: dllError.code, message: dllError.message } : null,
                });

                if (dllError) {
                  console.error("[agent/pdf-import] weather_station daily_light_logs upsert failed", {
                    organizationId,
                    filename: file.originalname,
                    code: dllError.code,
                    message: dllError.message,
                  });
                }
              }
            } else {
              console.warn("[agent/pdf-import] weather_station: 0 readings parsed — check column_mappings configuration", {
                organizationId,
                filename: file.originalname,
                exportTimestamp: parsed.exportTimestamp,
                mappingKeys: Object.keys(wsMappings).filter((k) => !!(wsMappings as Record<string, unknown>)[k]),
              });
            }

            results.push({ filename: file.originalname, status: "imported", importId });
          } catch (err) {
            results.push({
              filename: file.originalname,
              status: "error",
              reason: err instanceof Error ? err.message : "Failed to parse weather station CSV.",
            });
          }
          continue;
        }

        // ── yield_kg: parse and upsert to agent_pending_imports ───────────────
        let parsedFiles: FlowMasterParseResult[];
        try {
          parsedFiles = parseGenericCsvBuffer(file.buffer, file.originalname, columnMappings);
        } catch (err) {
          results.push({
            filename: file.originalname,
            status: "error",
            reason: err instanceof Error ? err.message : "Failed to parse CSV.",
          });
          continue;
        }

        for (const parsed of parsedFiles) {
          if (!parsed.lotNumber) {
            results.push({
              filename: file.originalname,
              status: "error",
              reason: "Could not extract unique key from file using the saved template.",
            });
            continue;
          }

          const { error: upsertError } = await supabase
            .from("agent_pending_imports")
            .upsert(
              {
                organization_id: organizationId,
                lot_number: parsed.lotNumber,
                variety_name: parsed.varietyName,
                source_filename: file.originalname,
                start_time: parsed.startTime,
                iso_year: parsed.isoYear,
                iso_week: parsed.isoWeek,
                average_fruit_weight_g: parsed.averageFruitWeightG,
                size_kg: parsed.sizeKg,
                parsed_total_kg: parsed.totalKg,
                warnings: parsed.warnings,
                unknown_sizes: parsed.unknownSizes,
                upload_key_label: uploadKeyLabel,
                upload_key_id: uploadKeyId,
                data_source_type: "generic_csv",
                source_type: "agent",
                needs_template: false,
                raw_payload: parsed,
                uploaded_at: new Date().toISOString(),
              },
              { onConflict: "organization_id,lot_number" }
            );

          if (upsertError) {
            console.error("[agent/pdf-import] generic_csv upsert failed", {
              organizationId,
              lotNumber: parsed.lotNumber,
              code: upsertError.code,
              message: upsertError.message,
            });
            results.push({ filename: file.originalname, status: "error", reason: "Failed to queue import for review." });
          } else {
            results.push({ filename: file.originalname, status: "queued", lotNumber: parsed.lotNumber });
          }
        }
      }

      const queued = results.filter((r) => r.status === "queued").length;
      const pendingTemplate = results.filter((r) => r.status === "pending_template").length;
      const errors = results.filter((r) => r.status === "error").length;

      return res.json({
        success: true,
        summary: { queued, pendingTemplate, errors },
        results,
      });
    }

    // ── csv_template path ───────────────────────────────────────────────────
    // The same physical Agent watches and uploads both .pdf and .csv files
    // using one upload key. A csv_template key must still route a PDF
    // through the existing FlowMaster PDF parser + pending-review path
    // (mirrored below, independently of the "flowmaster path" further down,
    // so that pinned code is never touched) — only CSVs go through the new
    // generic template engine. Routing is decided by validated file
    // content (a %PDF- magic-byte probe), never by filename extension
    // alone, per the multer fileFilter's own pdf/csv allowlist already
    // having run before this handler executes.
    if (dataSourceType === "csv_template") {
      const results: FileResult[] = [];

      for (const file of uploadedFiles) {
        if (isPdfBuffer(file.buffer)) {
          results.push(
            await processCsvTemplateKeyPdfFile(file, organizationId, uploadKeyLabel, uploadKeyId)
          );
          continue;
        }

        if (looksLikeBinaryGarbage(file.buffer)) {
          results.push({
            filename: file.originalname,
            status: "error",
            reason: "File does not look like a valid CSV or PDF (unrecognized binary content).",
          });
          continue;
        }

        results.push(await processCsvTemplateKeyCsvFile(file, organizationId));
      }

      const csvQueued = results.filter((r) => r.status === "csv_template_queued").length;
      const csvPendingTemplate = results.filter((r) => r.status === "csv_template_needs_template").length;
      const csvDuplicates = results.filter((r) => r.status === "duplicate").length;
      const csvErrors = results.filter((r) => r.status === "error").length;

      // Per-file "error" results still live inside a 200 batch response
      // elsewhere in this file (matching the existing flowmaster/generic_csv
      // convention) — but the Agent only ever sends ONE file per request
      // (confirmed by reading UploadService.cs), and only checks the HTTP
      // status code, never the response body, to decide whether to retry.
      // A per-file "error" hidden inside a 200 would be silently treated as
      // full success and moved to Uploaded, losing the ability to retry —
      // so an invalid/unsafe file here must produce a non-200 status.
      const hasError = csvErrors > 0;

      return res.status(hasError ? 422 : 200).json({
        success: !hasError,
        summary: {
          queued: csvQueued,
          pendingTemplate: csvPendingTemplate,
          duplicates: csvDuplicates,
          errors: csvErrors,
        },
        results,
      });
    }

    // ── flowmaster path (unchanged) ───────────────────────────────────────────
    const csvSettings = await fetchCsvSizeSettings(organizationId);

    type ParsedEntry = {
      filename: string;
      parsed: FlowMasterParseResult | null;
      parseError: string | null;
      // Raw file text, CSV files only (null for PDFs). Persisted into
      // raw_payload.csv_text below so a pending row can be fully re-parsed
      // later if a parser fix ships after this file was already queued —
      // without it, a stored row's sizeKg/dates/warnings are frozen forever
      // at whatever the parser produced at upload time.
      csvText: string | null;
    };
    const fileParseArrays = await Promise.all(
      uploadedFiles.map(async (file): Promise<ParsedEntry[]> => {
        const isCsv =
          /\.csv$/i.test(file.originalname) ||
          file.mimetype === "text/csv" ||
          file.mimetype === "application/csv";
        try {
          if (isCsv) {
            const csvText = file.buffer.toString("utf-8");
            const csvResults = parseFlowMasterCsvBuffer(
              file.buffer,
              file.originalname,
              csvSettings.ignoredSizeLabels,
              csvSettings.sizeAliases
            );
            if (csvResults.length === 0) {
              return [{ filename: file.originalname, parsed: null, parseError: "CSV contained no importable runs.", csvText }];
            }
            return csvResults.map((parsed) => ({ filename: file.originalname, parsed, parseError: null as null, csvText }));
          }
          const parsed = await parseFlowMasterPdfBuffer(file.buffer, file.originalname);
          return [{ filename: file.originalname, parsed, parseError: null as null, csvText: null }];
        } catch (err) {
          return [{
            filename: file.originalname,
            parsed: null,
            parseError: err instanceof Error ? err.message : "Failed to parse file.",
            csvText: null
          }];
        }
      })
    );
    const parsedFiles = fileParseArrays.flat();

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

    const fmResults: FileResult[] = [];
    const seenLotsInBatch = new Set<string>();

    for (const file of parsedFiles) {
      if (!file.parsed) {
        fmResults.push({
          filename: file.filename,
          status: "error",
          reason: file.parseError ?? "Failed to parse file."
        });
        continue;
      }

      const parsed = file.parsed;

      if (!parsed.lotNumber) {
        fmResults.push({
          filename: file.filename,
          status: "error",
          reason: "Could not extract lot number from file."
        });
        continue;
      }

      if (alreadyImportedLots.has(parsed.lotNumber)) {
        fmResults.push({
          filename: file.filename,
          status: "skipped",
          reason: "already_imported",
          lotNumber: parsed.lotNumber
        });
        continue;
      }

      if (seenLotsInBatch.has(parsed.lotNumber)) {
        fmResults.push({
          filename: file.filename,
          status: "skipped",
          reason: "duplicate_in_batch",
          lotNumber: parsed.lotNumber
        });
        continue;
      }

      seenLotsInBatch.add(parsed.lotNumber);

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
            upload_key_id: uploadKeyId,
            data_source_type: "flowmaster",
            source_type: "agent",
            needs_template: false,
            raw_payload: file.csvText !== null ? { ...parsed, csv_text: file.csvText } : parsed,
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
        fmResults.push({
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

      fmResults.push({
        filename: file.filename,
        status: "queued",
        lotNumber: parsed.lotNumber
      });
    }

    const queuedCount = fmResults.filter((r) => r.status === "queued").length;
    const skippedCount = fmResults.filter((r) => r.status === "skipped").length;
    const errorCount = fmResults.filter((r) => r.status === "error").length;

    return res.json({
      success: true,
      summary: { queued: queuedCount, skipped: skippedCount, errors: errorCount },
      results: fmResults
    });
  });
});

export { agentRouter, processCsvTemplateKeyCsvFile };
