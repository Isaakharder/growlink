import { Request, Response, Router } from "express";
import { requireAdminUser } from "../middleware/requireAdminUser";
import { requireOrganizationContext } from "../middleware/requireOrganizationContext";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";

type ImportRunRow = {
  id: string;
  lot_number: string;
  variety_id: string | null;
  iso_year: number | null;
  iso_week: number | null;
  start_time: string | null;
  source_filename: string | null;
  imported_at: string;
};

const adminFlowMasterImportRunsRouter = Router();

adminFlowMasterImportRunsRouter.use(requireAdminUser, requireOrganizationContext);

adminFlowMasterImportRunsRouter.get(
  "/admin/flowmaster/import-runs",
  async (req: Request, res: Response) => {
    const organizationId = req.organizationId;

    const { data: rows, error } = await supabase
      .from("yield_import_runs")
      .select("id, lot_number, variety_id, iso_year, iso_week, start_time, source_filename, imported_at")
      .eq("organization_id", organizationId)
      .order("imported_at", { ascending: false });

    if (error) {
      return sendSafeError(
        res,
        500,
        "Failed to load FlowMaster import runs.",
        "FlowMaster import run list error:",
        error
      );
    }

    const importRuns = (rows ?? []) as ImportRunRow[];
    const varietyIds = Array.from(
      new Set(
        importRuns
          .map((run) => run.variety_id)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
      )
    );

    const varietyNameById = new Map<string, string>();

    if (varietyIds.length > 0) {
      const { data: varieties, error: varietiesError } = await supabase
        .from("varieties")
        .select("id, name")
        .eq("organization_id", organizationId)
        .in("id", varietyIds);

      if (varietiesError) {
        return sendSafeError(
          res,
          500,
          "Failed to resolve variety names for import runs.",
          "FlowMaster import run variety lookup error:",
          varietiesError
        );
      }

      for (const variety of varieties ?? []) {
        varietyNameById.set(variety.id, variety.name);
      }
    }

    return res.json({
      success: true,
      notice:
        "Deleting import runs only clears duplicate/import history. It does not remove already-imported yield data.",
      runs: importRuns.map((run) => ({
        id: run.id,
        lotNumber: run.lot_number,
        sourceFilename: run.source_filename,
        varietyId: run.variety_id,
        varietyName: run.variety_id ? varietyNameById.get(run.variety_id) ?? null : null,
        isoYear: run.iso_year,
        isoWeek: run.iso_week,
        startTime: run.start_time,
        importedAt: run.imported_at
      }))
    });
  }
);

adminFlowMasterImportRunsRouter.post(
  "/admin/flowmaster/import-runs/delete",
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
      return sendSafeError(
        res,
        500,
        "Failed to delete selected import runs.",
        "FlowMaster import run delete error:",
        deleteError
      );
    }

    return res.json({
      success: true,
      requestedCount: ids.length,
      deletedCount: (deletedRows ?? []).length,
      notice:
        "Only import history was deleted. Existing yield entries remain unchanged."
    });
  }
);

export { adminFlowMasterImportRunsRouter };
