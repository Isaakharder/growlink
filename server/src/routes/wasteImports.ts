import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission } from "../middleware/requirePermission";

const wasteImportsRouter = Router();

const canWasteView = requireAnyPermission(["cases:view", "cases:edit"]);

wasteImportsRouter.get("/waste-imports", canWasteView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data: imports, error: importsError } = await supabase
    .from("waste_imports")
    .select("*")
    .eq("organization_id", organizationId)
    .order("year", { ascending: false })
    .order("week", { ascending: false })
    .order("variety_name_snapshot", { ascending: true });

  if (importsError) {
    return sendSafeError(res, 500, "Failed to load waste imports.", "Waste imports fetch error:", importsError);
  }

  // Resolve GrowLink variety names for matched rows via a separate query.
  // waste_imports.variety_id has no FK constraint, so Supabase's embedded
  // relation syntax (.select("*, variety:varieties(name)")) would fail.
  const varietyIds = (imports ?? [])
    .map((r) => r.variety_id as string | null)
    .filter((id): id is string => id !== null);

  const varietyNameById = new Map<string, string>();

  if (varietyIds.length > 0) {
    const { data: varieties } = await supabase
      .from("varieties")
      .select("id, name")
      .in("id", varietyIds)
      .eq("organization_id", organizationId);

    for (const v of varieties ?? []) {
      varietyNameById.set(v.id, v.name);
    }
  }

  const enriched = (imports ?? []).map((row) => ({
    ...row,
    variety: row.variety_id
      ? { name: varietyNameById.get(row.variety_id as string) ?? null }
      : null
  }));

  return res.json(enriched);
});

export { wasteImportsRouter };
