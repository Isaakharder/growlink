import { createHash } from "crypto";
import { Router } from "express";
import { supabase } from "../config/supabase";
import { requireAdminUser } from "../middleware/requireAdminUser";
import { sendSafeError } from "../utils/safeError";
import { parseCsvText, parseGenericCsvBuffer, type ColumnMappings } from "../utils/genericCsvParser";
import {
  parseWeatherStationCsv,
  type WeatherStationMappings,
} from "../utils/weatherStationCsvParser";

const importSourceTemplatesRouter = Router();

// ── GET /api/admin/import-templates/by-key/:uploadKeyId ───────────────────────
// Returns: key info, existing template (or null), CSV preview from the first
// needs_template pending import, and active yield sizes for the org.
importSourceTemplatesRouter.get(
  "/admin/import-templates/by-key/:uploadKeyId",
  requireAdminUser,
  async (req, res) => {
    const uploadKeyId = req.params.uploadKeyId as string;
    if (!uploadKeyId?.trim()) {
      return res.status(400).json({ message: "uploadKeyId is required." });
    }

    const { data: keyRow, error: keyError } = await supabase
      .from("organization_upload_keys")
      .select("id, organization_id, label, data_source_type, status")
      .eq("id", uploadKeyId)
      .maybeSingle();

    if (keyError) {
      return sendSafeError(res, 500, "Failed to load upload key.", "import-templates key fetch:", keyError);
    }
    if (!keyRow) {
      return res.status(404).json({ message: "Upload key not found." });
    }

    const organizationId = keyRow.organization_id as string;

    const [templateResult, pendingResult, sizesResult, orgResult] = await Promise.all([
      supabase
        .from("import_source_templates")
        .select("id, name, file_type, import_type, column_mappings, created_at, updated_at")
        .eq("upload_key_id", uploadKeyId)
        .maybeSingle(),
      supabase
        .from("agent_pending_imports")
        .select("id, source_filename, raw_payload")
        .eq("organization_id", organizationId)
        .eq("upload_key_id", uploadKeyId)
        .eq("needs_template", true)
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("yield_sizes")
        .select("id, name")
        .eq("organization_id", organizationId)
        .eq("status", "active")
        .order("sort_order", { ascending: true }),
      supabase
        .from("organizations")
        .select("name")
        .eq("id", organizationId)
        .maybeSingle(),
    ]);

    if (templateResult.error) {
      return sendSafeError(res, 500, "Failed to load template.", "import-templates fetch:", templateResult.error);
    }
    if (sizesResult.error) {
      return sendSafeError(res, 500, "Failed to load yield sizes.", "import-templates sizes fetch:", sizesResult.error);
    }

    // Build CSV preview from the most recent needs_template pending import.
    let csvPreview: { headers: string[]; rows: string[][] } | null = null;
    let previewFilename: string | null = null;
    let needsTemplateCount = 0;

    if (pendingResult.data) {
      const rawPayload = pendingResult.data.raw_payload as Record<string, unknown> | null;
      const csvText = typeof rawPayload?.csv_text === "string" ? rawPayload.csv_text : null;
      if (csvText) {
        const parsed = parseCsvText(csvText);
        csvPreview = {
          headers: parsed.headers,
          rows: parsed.rows.slice(0, 20),
        };
        previewFilename = pendingResult.data.source_filename as string;
      }
    }

    // Count all pending imports for this key that need a template.
    const { count } = await supabase
      .from("agent_pending_imports")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("upload_key_id", uploadKeyId)
      .eq("needs_template", true);

    needsTemplateCount = count ?? 0;

    return res.json({
      success: true,
      key: {
        id: keyRow.id,
        label: keyRow.label,
        dataSourceType: keyRow.data_source_type,
        status: keyRow.status,
        organizationId,
        organizationName: (orgResult.data as { name: string } | null)?.name ?? "Unknown",
      },
      template: templateResult.data ?? null,
      csvPreview,
      previewFilename,
      yieldSizes: (sizesResult.data ?? []) as { id: string; name: string }[],
      needsTemplateCount,
    });
  }
);

// ── POST /api/admin/import-templates/by-key/:uploadKeyId ─────────────────────
// Creates or updates the template for this upload key.
importSourceTemplatesRouter.post(
  "/admin/import-templates/by-key/:uploadKeyId",
  requireAdminUser,
  async (req, res) => {
    const uploadKeyId = req.params.uploadKeyId as string;
    if (!uploadKeyId?.trim()) {
      return res.status(400).json({ message: "uploadKeyId is required." });
    }

    const body = req.body as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const columnMappings = body.columnMappings;
    const rawImportType = typeof body.importType === "string" ? body.importType : "yield_kg";
    const importType: "yield_kg" | "weather_station" =
      rawImportType === "weather_station" ? "weather_station" : "yield_kg";

    if (!name) {
      return res.status(400).json({ message: "Template name is required." });
    }
    if (!columnMappings || typeof columnMappings !== "object" || Array.isArray(columnMappings)) {
      return res.status(400).json({ message: "columnMappings must be an object." });
    }

    const cm = columnMappings as Record<string, unknown>;
    if (importType === "yield_kg") {
      if (typeof cm.unique_key_column !== "string" || !cm.unique_key_column.trim()) {
        return res.status(400).json({ message: "unique_key_column is required in columnMappings." });
      }
    } else {
      if (typeof cm.radiation_sum_key !== "string" || !cm.radiation_sum_key.trim()) {
        return res.status(400).json({ message: "radiation_sum_key is required for weather_station templates." });
      }
    }

    // Verify the upload key exists and get its organization.
    const { data: keyRow, error: keyError } = await supabase
      .from("organization_upload_keys")
      .select("id, organization_id")
      .eq("id", uploadKeyId)
      .maybeSingle();

    if (keyError) {
      return sendSafeError(res, 500, "Failed to verify upload key.", "import-templates key verify:", keyError);
    }
    if (!keyRow) {
      return res.status(404).json({ message: "Upload key not found." });
    }

    const { data: upserted, error: upsertError } = await supabase
      .from("import_source_templates")
      .upsert(
        {
          organization_id: keyRow.organization_id,
          upload_key_id: uploadKeyId,
          name,
          file_type: "csv",
          import_type: importType,
          column_mappings: columnMappings,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,upload_key_id" }
      )
      .select("id, name, import_type, column_mappings, created_at, updated_at")
      .single();

    if (upsertError || !upserted) {
      return sendSafeError(res, 500, "Failed to save template.", "import-templates upsert:", upsertError);
    }

    return res.json({ success: true, template: upserted });
  }
);

// ── POST /api/admin/import-templates/by-key/:uploadKeyId/apply ────────────────
// Re-processes all needs_template pending imports for this key using the saved
// template. Returns counts of applied, skipped, and failed rows.
importSourceTemplatesRouter.post(
  "/admin/import-templates/by-key/:uploadKeyId/apply",
  requireAdminUser,
  async (req, res) => {
    const uploadKeyId = req.params.uploadKeyId as string;
    if (!uploadKeyId?.trim()) {
      return res.status(400).json({ message: "uploadKeyId is required." });
    }

    // Load the template.
    const { data: template, error: templateError } = await supabase
      .from("import_source_templates")
      .select("id, organization_id, import_type, column_mappings")
      .eq("upload_key_id", uploadKeyId)
      .maybeSingle();

    if (templateError) {
      return sendSafeError(res, 500, "Failed to load template.", "import-templates apply fetch:", templateError);
    }
    if (!template) {
      return res.status(404).json({ message: "No template found for this upload key. Save a template first." });
    }

    const organizationId = template.organization_id as string;
    const templateImportType = (template.import_type as string | null) ?? "yield_kg";

    // Load all pending imports that need the template applied.
    const { data: pendingRows, error: pendingError } = await supabase
      .from("agent_pending_imports")
      .select("id, source_filename, raw_payload, upload_key_id")
      .eq("organization_id", organizationId)
      .eq("upload_key_id", uploadKeyId)
      .eq("needs_template", true);

    if (pendingError) {
      return sendSafeError(res, 500, "Failed to load pending imports.", "import-templates apply pending:", pendingError);
    }

    const rows = (pendingRows ?? []) as Array<{
      id: string;
      source_filename: string;
      raw_payload: Record<string, unknown> | null;
      upload_key_id: string | null;
    }>;

    if (rows.length === 0) {
      return res.json({ success: true, applied: 0, skipped: 0, failed: 0 });
    }

    let applied = 0;
    let skipped = 0;
    let failed = 0;

    // ── yield_kg apply path ───────────────────────────────────────────────────
    if (templateImportType === "yield_kg") {
      const columnMappings = template.column_mappings as ColumnMappings;

      for (const row of rows) {
        const csvText = typeof row.raw_payload?.csv_text === "string"
          ? row.raw_payload.csv_text
          : null;

        if (!csvText) {
          skipped++;
          continue;
        }

        try {
          const parsed = parseGenericCsvBuffer(
            Buffer.from(csvText, "utf-8"),
            row.source_filename,
            columnMappings
          );

          if (parsed.length === 0) {
            skipped++;
            continue;
          }

          // Use first parsed result per file (most generic CSVs have one lot per file;
          // multi-lot CSVs are handled by the agent path which fans them into separate rows).
          const p = parsed[0];

          const { error: updateError } = await supabase
            .from("agent_pending_imports")
            .update({
              lot_number: p.lotNumber,
              variety_name: p.varietyName,
              start_time: p.startTime,
              iso_year: p.isoYear,
              iso_week: p.isoWeek,
              size_kg: p.sizeKg,
              parsed_total_kg: p.totalKg,
              warnings: p.warnings,
              needs_template: false,
            })
            .eq("id", row.id)
            .eq("organization_id", organizationId);

          if (updateError) {
            console.error("[import-templates apply] yield_kg update failed", { id: row.id, error: updateError.message });
            failed++;
          } else {
            applied++;
          }
        } catch (err) {
          console.error("[import-templates apply] yield_kg parse error", {
            id: row.id,
            filename: row.source_filename,
            error: err instanceof Error ? err.message : String(err),
          });
          failed++;
        }
      }

      return res.json({ success: true, applied, skipped, failed });
    }

    // ── weather_station apply path ────────────────────────────────────────────
    // Writes to climate_imports → climate_readings → daily_light_logs, exactly
    // mirroring what the Windows Climate Agent does via POST /agent/climate-import.
    const wsMappings = template.column_mappings as WeatherStationMappings;

    for (const row of rows) {
      const csvText = typeof row.raw_payload?.csv_text === "string"
        ? row.raw_payload.csv_text
        : null;

      if (!csvText) {
        skipped++;
        continue;
      }

      try {
        const parsed = parseWeatherStationCsv(
          Buffer.from(csvText, "utf-8"),
          row.source_filename,
          wsMappings
        );

        // Dedup: skip if this file hash is already in climate_imports.
        const { data: existingImport } = await supabase
          .from("climate_imports")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("file_hash", parsed.fileHash)
          .maybeSingle();

        if (existingImport) {
          // Already imported — just clear the pending flag.
          await supabase
            .from("agent_pending_imports")
            .update({ needs_template: false })
            .eq("id", row.id)
            .eq("organization_id", organizationId);
          skipped++;
          continue;
        }

        // Insert climate_imports record.
        const { data: insertedImport, error: importInsertError } = await supabase
          .from("climate_imports")
          .insert({
            organization_id: organizationId,
            source_file: row.source_filename,
            file_type: "weather_station",
            export_timestamp: parsed.exportTimestamp,
            file_hash: parsed.fileHash,
            row_count: parsed.readings.length,
            upload_key_label: null,
          })
          .select("id")
          .single();

        if (importInsertError || !insertedImport) {
          console.error("[import-templates apply] weather_station climate_imports insert failed", {
            id: row.id,
            error: importInsertError?.message,
          });
          failed++;
          continue;
        }

        const importId = insertedImport.id as string;

        // Insert climate_readings rows.
        if (parsed.readings.length > 0) {
          const readingRows = parsed.readings.map((r) => ({
            organization_id: organizationId,
            import_id: importId,
            timestamp: parsed.exportTimestamp,
            zone_label: r.zone_label,
            metric_name: r.metric_name,
            metric_value: r.metric_value,
            unit: r.unit,
            source_file: row.source_filename,
          }));

          const { error: readingsInsertError } = await supabase
            .from("climate_readings")
            .upsert(readingRows, {
              onConflict: "organization_id,timestamp,zone_key,metric_name",
              ignoreDuplicates: true,
            });

          if (readingsInsertError) {
            console.error("[import-templates apply] weather_station climate_readings upsert failed", {
              id: row.id,
              error: readingsInsertError.message,
            });
            // Non-fatal: still mark as applied and sync daily light if possible.
          }

          // Sync daily_light_logs: sum radiation_sum readings across all stations.
          const radiationReadings = parsed.readings.filter(
            (r) => r.metric_name === "radiation_sum"
          );
          if (radiationReadings.length > 0) {
            const totalRadiation = radiationReadings.reduce(
              (sum, r) => sum + r.metric_value,
              0
            );
            const logDate = parsed.exportTimestamp.slice(0, 10);
            const { error: lightUpsertError } = await supabase
              .from("daily_light_logs")
              .upsert(
                {
                  organization_id: organizationId,
                  log_date: logDate,
                  joules_per_cm2: totalRadiation,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "organization_id,log_date" }
              );
            if (lightUpsertError) {
              console.error("[import-templates apply] weather_station daily_light_logs upsert failed", {
                id: row.id,
                error: lightUpsertError.message,
              });
            }
          }
        }

        // Clear the pending flag on the agent_pending_imports row.
        const { error: clearError } = await supabase
          .from("agent_pending_imports")
          .update({ needs_template: false })
          .eq("id", row.id)
          .eq("organization_id", organizationId);

        if (clearError) {
          console.error("[import-templates apply] weather_station pending clear failed", {
            id: row.id,
            error: clearError.message,
          });
          failed++;
        } else {
          applied++;
        }
      } catch (err) {
        console.error("[import-templates apply] weather_station parse error", {
          id: row.id,
          filename: row.source_filename,
          error: err instanceof Error ? err.message : String(err),
        });
        failed++;
      }
    }

    return res.json({ success: true, applied, skipped, failed });
  }
);

// ── DELETE /api/admin/import-templates/by-key/:uploadKeyId ───────────────────
// Removes the template for this key so it can be reconfigured.
importSourceTemplatesRouter.delete(
  "/admin/import-templates/by-key/:uploadKeyId",
  requireAdminUser,
  async (req, res) => {
    const uploadKeyId = req.params.uploadKeyId as string;
    if (!uploadKeyId?.trim()) {
      return res.status(400).json({ message: "uploadKeyId is required." });
    }

    const { error } = await supabase
      .from("import_source_templates")
      .delete()
      .eq("upload_key_id", uploadKeyId);

    if (error) {
      return sendSafeError(res, 500, "Failed to delete template.", "import-templates delete:", error);
    }

    return res.json({ success: true });
  }
);

export { importSourceTemplatesRouter };
