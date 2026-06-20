import { Router } from "express";
import { supabase } from "../config/supabase";
import { requireAdminUser } from "../middleware/requireAdminUser";
import { sendSafeError } from "../utils/safeError";
import { parseCsvText, parseGenericCsvBuffer, type ColumnMappings } from "../utils/genericCsvParser";

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
        .select("id, name, file_type, column_mappings, created_at, updated_at")
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

    if (!name) {
      return res.status(400).json({ message: "Template name is required." });
    }
    if (!columnMappings || typeof columnMappings !== "object" || Array.isArray(columnMappings)) {
      return res.status(400).json({ message: "columnMappings must be an object." });
    }

    const cm = columnMappings as Record<string, unknown>;
    if (typeof cm.unique_key_column !== "string" || !cm.unique_key_column.trim()) {
      return res.status(400).json({ message: "unique_key_column is required in columnMappings." });
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
          column_mappings: columnMappings,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,upload_key_id" }
      )
      .select("id, name, column_mappings, created_at, updated_at")
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
      .select("id, organization_id, column_mappings")
      .eq("upload_key_id", uploadKeyId)
      .maybeSingle();

    if (templateError) {
      return sendSafeError(res, 500, "Failed to load template.", "import-templates apply fetch:", templateError);
    }
    if (!template) {
      return res.status(404).json({ message: "No template found for this upload key. Save a template first." });
    }

    const organizationId = template.organization_id as string;
    const columnMappings = template.column_mappings as ColumnMappings;

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
          console.error("[import-templates apply] update failed", { id: row.id, error: updateError.message });
          failed++;
        } else {
          applied++;
        }
      } catch (err) {
        console.error("[import-templates apply] parse error", {
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
