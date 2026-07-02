import { Request, Response, Router } from "express";
import { supabase } from "../config/supabase";
import { requireIntegrationKey } from "../middleware/requireIntegrationKey";
import { sendSafeError } from "../utils/safeError";

// Read-only API for CropLink. GrowLink is the single source of truth for
// harvested kilograms by variety — CropLink consumes this instead of
// reading GrowLink's database directly.
const croplinkIntegrationRouter = Router();

const requireCroplinkKey = requireIntegrationKey("croplink");

type VarietyRow = {
  id: string;
  name: string;
  color: string;
};

croplinkIntegrationRouter.get(
  "/integrations/croplink/varieties",
  requireCroplinkKey,
  async (req: Request, res: Response) => {
    const organizationId = req.organizationId;

    const { data, error } = await supabase
      .from("varieties")
      .select("id, name, color")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("name", { ascending: true });

    if (error) {
      return sendSafeError(
        res, 500,
        "Failed to load varieties.",
        "CropLink varieties fetch error:",
        error
      );
    }

    const varieties = ((data ?? []) as VarietyRow[]).map((variety) => ({
      varietyId: variety.id,
      name: variety.name,
      color: variety.color,
      active: true
    }));

    return res.json({ varieties });
  }
);

type YieldEntryRow = {
  id: string;
  variety_id: string;
  year: number;
  week: number;
  packed_date: string | null;
  total_kg: number;
  updated_at: string;
  varieties: { name: string } | { name: string }[] | null;
};

function resolveVarietyName(varietyRef: YieldEntryRow["varieties"]): string {
  if (Array.isArray(varietyRef)) return varietyRef[0]?.name ?? "";
  return varietyRef?.name ?? "";
}

croplinkIntegrationRouter.get(
  "/integrations/croplink/harvest-actuals",
  requireCroplinkKey,
  async (req: Request, res: Response) => {
    const organizationId = req.organizationId;
    const sinceRaw = req.query.since;

    let since: string | null = null;
    if (typeof sinceRaw === "string" && sinceRaw.trim().length > 0) {
      const parsed = new Date(sinceRaw.trim());
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: "since must be a valid ISO 8601 timestamp." });
      }
      since = parsed.toISOString();
    }

    let query = supabase
      .from("yield_entries")
      .select("id, variety_id, year, week, packed_date, total_kg, updated_at, varieties(name)")
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: true });

    if (since) {
      query = query.gt("updated_at", since);
    }

    const { data, error } = await query;

    if (error) {
      return sendSafeError(
        res, 500,
        "Failed to load harvest actuals.",
        "CropLink harvest-actuals fetch error:",
        error
      );
    }

    const harvestActuals = ((data ?? []) as unknown as YieldEntryRow[]).map((entry) => ({
      harvestId: entry.id,
      varietyId: entry.variety_id,
      varietyName: resolveVarietyName(entry.varieties),
      harvestDate: entry.packed_date,
      year: entry.year,
      week: entry.week,
      harvestKg: Number(entry.total_kg ?? 0),
      updatedAt: entry.updated_at
    }));

    return res.json({ harvestActuals });
  }
);

export { croplinkIntegrationRouter };
