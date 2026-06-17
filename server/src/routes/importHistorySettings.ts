import { type NextFunction, type Request, type Response, Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";

// ── middleware ────────────────────────────────────────────────────────────────

async function requireOrgOwnerOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.userId) {
    return res.status(401).json({ message: "Authentication required." });
  }

  const { data, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("user_id", req.userId)
    .eq("organization_id", req.organizationId)
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to verify role.", "Role lookup error:", error);
  }

  const role = (data as { role: string } | null)?.role;
  if (role !== "owner" && role !== "admin") {
    return res.status(403).json({ message: "Only organization owners and admins can manage import history." });
  }

  return next();
}

// ── router ────────────────────────────────────────────────────────────────────

type ImportRunRow = {
  id: string;
  lot_number: string;
  variety_id: string | null;
  iso_year: number | null;
  iso_week: number | null;
  source_filename: string | null;
  imported_at: string;
};

const importHistorySettingsRouter = Router();

importHistorySettingsRouter.get(
  "/settings/import-runs",
  requireOrgOwnerOrAdmin,
  async (req: Request, res: Response) => {
    const organizationId = req.organizationId;

    const { data: rows, error } = await supabase
      .from("yield_import_runs")
      .select("id, lot_number, variety_id, iso_year, iso_week, source_filename, imported_at")
      .eq("organization_id", organizationId)
      .order("imported_at", { ascending: false });

    if (error) {
      return sendSafeError(res, 500, "Failed to load import history.", "Import runs list error:", error);
    }

    const importRuns = (rows ?? []) as ImportRunRow[];
    const varietyIds = Array.from(
      new Set(
        importRuns
          .map((r) => r.variety_id)
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      )
    );

    const varietyNameById = new Map<string, string>();

    if (varietyIds.length > 0) {
      const { data: varieties, error: varietyError } = await supabase
        .from("varieties")
        .select("id, name")
        .eq("organization_id", organizationId)
        .in("id", varietyIds);

      if (varietyError) {
        return sendSafeError(res, 500, "Failed to resolve variety names.", "Variety lookup error:", varietyError);
      }

      for (const v of varieties ?? []) {
        varietyNameById.set(v.id, v.name);
      }
    }

    return res.json({
      success: true,
      runs: importRuns.map((r) => ({
        id: r.id,
        lotNumber: r.lot_number,
        sourceFilename: r.source_filename,
        varietyId: r.variety_id,
        varietyName: r.variety_id ? (varietyNameById.get(r.variety_id) ?? null) : null,
        isoYear: r.iso_year,
        isoWeek: r.iso_week,
        importedAt: r.imported_at,
      })),
    });
  }
);

importHistorySettingsRouter.post(
  "/settings/import-runs/delete",
  requireOrgOwnerOrAdmin,
  async (req: Request, res: Response) => {
    const organizationId = req.organizationId;
    const rawIds = (req.body as { ids?: unknown })?.ids;

    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return res.status(400).json({ message: "ids must be a non-empty array." });
    }

    const ids = Array.from(
      new Set(
        rawIds
          .filter((id): id is string => typeof id === "string")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      )
    );

    if (ids.length === 0) {
      return res.status(400).json({ message: "No valid import run ids were provided." });
    }

    const { data: deletedRows, error: deleteError } = await supabase
      .from("yield_import_runs")
      .delete()
      .eq("organization_id", organizationId)
      .in("id", ids)
      .select("id");

    if (deleteError) {
      return sendSafeError(res, 500, "Failed to delete import history.", "Import runs delete error:", deleteError);
    }

    return res.json({
      success: true,
      deletedCount: (deletedRows ?? []).length,
    });
  }
);

export { importHistorySettingsRouter };
