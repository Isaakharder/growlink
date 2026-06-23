import { createHash } from "crypto";
import multer from "multer";
import { Request, Response, Router } from "express";
import { supabase } from "../config/supabase";
import { requireUploadKey } from "../middleware/requireUploadKey";
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
  | { filename: string; status: "error"; reason: string };

// POST /api/agent/pdf-import
// Accepts multipart PDFs/CSVs. Routing by data_source_type:
//   flowmaster  → existing FlowMaster PDF/CSV parsers (unchanged)
//   generic_csv → template-driven CSV parser; if no template is saved yet,
//                 stores raw CSV and marks as needs_template=true
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
    const uploadKeyId = req.uploadKeyId ?? null;
    const dataSourceType = req.dataSourceType ?? "flowmaster";

    if (dataSourceType !== "flowmaster" && dataSourceType !== "generic_csv") {
      return res.status(400).json({
        message: `Unsupported data source type: ${dataSourceType}. Contact GrowLink support.`
      });
    }

    // ── generic_csv path ──────────────────────────────────────────────────────
    if (dataSourceType === "generic_csv") {
      // Look up the saved template for this upload key.
      const { data: templateRow } = await supabase
        .from("import_source_templates")
        .select("column_mappings, import_type")
        .eq("upload_key_id", uploadKeyId)
        .maybeSingle();

      const columnMappings = templateRow?.column_mappings as ColumnMappings | null;
      const templateImportType = (templateRow?.import_type as string | null) ?? "yield_kg";
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
          // No template yet — store raw CSV so admin can configure the mapping.
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

            // Dedup against climate_imports.
            const { data: existing } = await supabase
              .from("climate_imports")
              .select("id")
              .eq("organization_id", organizationId)
              .eq("file_hash", parsed.fileHash)
              .maybeSingle();

            if (existing) {
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
                      updated_at: new Date().toISOString(),
                    },
                    { onConflict: "organization_id,log_date" }
                  );

                if (dllError) {
                  console.error("[agent/pdf-import] weather_station daily_light_logs upsert failed", {
                    organizationId,
                    filename: file.originalname,
                    code: dllError.code,
                    message: dllError.message,
                  });
                }
              }
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

    // ── flowmaster path (unchanged) ───────────────────────────────────────────
    const csvSettings = await fetchCsvSizeSettings(organizationId);

    type ParsedEntry = { filename: string; parsed: FlowMasterParseResult | null; parseError: string | null };
    const fileParseArrays = await Promise.all(
      uploadedFiles.map(async (file): Promise<ParsedEntry[]> => {
        const isCsv =
          /\.csv$/i.test(file.originalname) ||
          file.mimetype === "text/csv" ||
          file.mimetype === "application/csv";
        try {
          if (isCsv) {
            const csvResults = parseFlowMasterCsvBuffer(
              file.buffer,
              file.originalname,
              csvSettings.ignoredSizeLabels,
              csvSettings.sizeAliases
            );
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

export { agentRouter };
