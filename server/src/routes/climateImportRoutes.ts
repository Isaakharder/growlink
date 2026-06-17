import { Request, Response, Router } from "express";
import { supabase } from "../config/supabase";
import { requireUploadKey } from "../middleware/requireUploadKey";

const climateImportRouter = Router();

// GrowLink only ingests Weather Station light/radiation data. Block summary
// climate data (air temperature, heating setpoint, RH) belongs to CropLink
// and is rejected here rather than silently dropped.
const VALID_FILE_TYPES = new Set(["weather_station"]);
const ACCEPTED_METRIC_NAME = "radiation_sum";

interface ReadingInput {
  zone_label: string | null;
  metric_name: string;
  metric_value: number;
  unit: string;
}

interface ClimateImportBody {
  source_file: string;
  file_type: "weather_station";
  export_timestamp: string;
  file_hash: string;
  readings: ReadingInput[];
}

function validateBody(body: unknown): body is ClimateImportBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.source_file !== "string" || !b.source_file) return false;
  if (typeof b.file_type !== "string" || !VALID_FILE_TYPES.has(b.file_type)) return false;
  if (typeof b.export_timestamp !== "string" || isNaN(Date.parse(b.export_timestamp))) return false;
  if (typeof b.file_hash !== "string" || !b.file_hash) return false;
  if (!Array.isArray(b.readings)) return false;
  for (const r of b.readings) {
    if (typeof r !== "object" || r === null) return false;
    const reading = r as Record<string, unknown>;
    if (reading.zone_label !== null && typeof reading.zone_label !== "string") return false;
    if (typeof reading.metric_name !== "string" || !reading.metric_name) return false;
    if (typeof reading.metric_value !== "number" || !Number.isFinite(reading.metric_value)) return false;
    if (typeof reading.unit !== "string" || !reading.unit) return false;
  }
  return true;
}

// POST /api/agent/climate-import
// Accepts Weather Station CSV exports from the GrowLink Climate Agent.
// Block summary exports are rejected -- that data belongs to CropLink, not
// GrowLink. Idempotent on file_hash; individual readings are upserted with
// ON CONFLICT DO NOTHING against the dedupe index so a retried/duplicate
// file never creates duplicate rows.
climateImportRouter.post(
  "/agent/climate-import",
  requireUploadKey,
  async (req: Request, res: Response) => {
    const rawFileType = (req.body as Record<string, unknown> | null)?.file_type;
    if (rawFileType === "block_summary") {
      return res.status(400).json({
        message:
          "GrowLink no longer accepts block_summary imports. Block summary climate data belongs to CropLink."
      });
    }

    if (!validateBody(req.body)) {
      return res.status(400).json({ message: "Invalid climate import payload." });
    }

    const organizationId = req.organizationId;
    const uploadKeyLabel = req.uploadKeyLabel ?? null;
    const { source_file, file_type, export_timestamp, file_hash, readings: allReadings } = req.body;

    // GrowLink only stores radiation_sum, even from a weather_station file --
    // defensive in case the agent ever reports other weather station metrics.
    const readings = allReadings.filter((reading) => reading.metric_name === ACCEPTED_METRIC_NAME);

    const { data: existingImport, error: existingError } = await supabase
      .from("climate_imports")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("file_hash", file_hash)
      .maybeSingle();

    if (existingError) {
      console.error("[agent/climate-import] dedupe lookup failed:", existingError);
      return res.status(500).json({ message: "Failed to check for duplicate import." });
    }

    if (existingImport) {
      return res.status(200).json({ status: "duplicate", importId: existingImport.id });
    }

    const { data: insertedImport, error: insertImportError } = await supabase
      .from("climate_imports")
      .insert({
        organization_id: organizationId,
        source_file,
        file_type,
        export_timestamp,
        file_hash,
        row_count: readings.length,
        upload_key_label: uploadKeyLabel
      })
      .select("id")
      .single();

    if (insertImportError || !insertedImport) {
      console.error("[agent/climate-import] import insert failed:", insertImportError);
      return res.status(500).json({ message: "Failed to record import." });
    }

    const importId = insertedImport.id;

    const rows = readings.map((reading) => ({
      organization_id: organizationId,
      import_id: importId,
      timestamp: export_timestamp,
      zone_label: reading.zone_label,
      metric_name: reading.metric_name,
      metric_value: reading.metric_value,
      unit: reading.unit,
      source_file
    }));

    let storedCount = 0;
    if (rows.length > 0) {
      const { data: insertedRows, error: insertReadingsError } = await supabase
        .from("climate_readings")
        .upsert(rows, {
          onConflict: "organization_id,timestamp,zone_key,metric_name",
          ignoreDuplicates: true
        })
        .select("id");

      if (insertReadingsError) {
        console.error("[agent/climate-import] readings insert failed:", insertReadingsError);
        return res.status(500).json({ message: "Failed to store climate readings." });
      }
      storedCount = insertedRows?.length ?? 0;
    }

    // Radiation Sum doubles as the site's daily light total. Sum across
    // stations in case a site has more than one, since daily_light_logs
    // holds a single org-wide value per day, not per-station.
    let dailyLightSynced = false;
    if (readings.length > 0) {
      const totalRadiationSum = readings.reduce((sum, r) => sum + r.metric_value, 0);
      const logDate = export_timestamp.slice(0, 10);

      const { error: lightUpsertError } = await supabase.from("daily_light_logs").upsert(
        {
          organization_id: organizationId,
          log_date: logDate,
          joules_per_cm2: totalRadiationSum,
          updated_at: new Date().toISOString()
        },
        { onConflict: "organization_id,log_date" }
      );

      if (lightUpsertError) {
        console.error("[agent/climate-import] daily_light_logs sync failed:", lightUpsertError);
      } else {
        dailyLightSynced = true;
      }
    }

    console.log("[agent/climate-import] stored", {
      organizationId,
      sourceFile: source_file,
      fileType: file_type,
      readingsStored: storedCount,
      dailyLightSynced
    });

    return res.status(201).json({
      status: "created",
      importId,
      readingsStored: storedCount,
      dailyLightSynced
    });
  }
);

export { climateImportRouter };
