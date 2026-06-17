import { Request, Response, Router } from "express";
import { requireAdminUser } from "../middleware/requireAdminUser";
import { requireOrganizationContext } from "../middleware/requireOrganizationContext";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";

const adminClimateImportsRouter = Router();

// GET /api/admin/climate-imports/summary
// Mirrors the scoping of /api/admin/flowmaster/import-runs: the requesting
// admin's own organization, not a cross-org aggregate.
adminClimateImportsRouter.get(
  "/admin/climate-imports/summary",
  requireAdminUser,
  requireOrganizationContext,
  async (req: Request, res: Response) => {
    const organizationId = req.organizationId;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [totalImportsResult, lastImportResult, readingsTodayResult] = await Promise.all([
      supabase
        .from("climate_imports")
        .select("*", { count: "exact", head: true })
        .eq("organization_id", organizationId),
      supabase
        .from("climate_imports")
        .select("received_at")
        .eq("organization_id", organizationId)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("climate_readings")
        .select("*", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .gte("created_at", startOfToday.toISOString())
    ]);

    if (totalImportsResult.error) {
      return sendSafeError(
        res, 500,
        "Failed to load climate import count.",
        "admin/climate-imports/summary total error:",
        totalImportsResult.error
      );
    }
    if (lastImportResult.error) {
      return sendSafeError(
        res, 500,
        "Failed to load last climate import.",
        "admin/climate-imports/summary last-import error:",
        lastImportResult.error
      );
    }
    if (readingsTodayResult.error) {
      return sendSafeError(
        res, 500,
        "Failed to load today's climate readings count.",
        "admin/climate-imports/summary readings-today error:",
        readingsTodayResult.error
      );
    }

    return res.json({
      success: true,
      totalImports: totalImportsResult.count ?? 0,
      lastImportAt: lastImportResult.data?.received_at ?? null,
      readingsToday: readingsTodayResult.count ?? 0
    });
  }
);

export { adminClimateImportsRouter };
