import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAnyPermission } from "../middleware/requirePermission";

const router = Router();

// Requires the same permission as the Environment page gate (matches dailyLight.ts).
const canAccess = requireAnyPermission(["irrigation:view"]);

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseStartBound(value: unknown): string | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (isNaN(Date.parse(trimmed))) return "invalid";
  return trimmed;
}

function parseEndBound(value: unknown): string | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (isNaN(Date.parse(trimmed))) return "invalid";
  // Date-only end bounds are made inclusive of the whole day.
  return isDateOnly(trimmed) ? `${trimmed}T23:59:59.999Z` : trimmed;
}

// GET /api/climate/readings?metric_name=&zone_label=&start_date=&end_date=&limit=
// Returns recent climate_readings for the caller's organization, newest first.
router.get("/climate/readings", canAccess, async (req, res) => {
  const orgId = req.organizationId;

  const startBound = parseStartBound(req.query.start_date);
  if (startBound === "invalid") {
    return res.status(400).json({ message: "start_date must be a valid date." });
  }

  const endBound = parseEndBound(req.query.end_date);
  if (endBound === "invalid") {
    return res.status(400).json({ message: "end_date must be a valid date." });
  }

  const rawLimit = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;

  let query = supabase
    .from("climate_readings")
    .select("id, timestamp, zone_label, metric_name, metric_value, unit, source_file")
    .eq("organization_id", orgId)
    .order("timestamp", { ascending: false })
    .limit(limit);

  const metricName = req.query.metric_name;
  if (typeof metricName === "string" && metricName.trim()) {
    query = query.eq("metric_name", metricName.trim());
  }

  const zoneLabel = req.query.zone_label;
  if (typeof zoneLabel === "string" && zoneLabel.trim()) {
    query = query.eq("zone_label", zoneLabel.trim());
  }

  if (startBound) {
    query = query.gte("timestamp", startBound);
  }

  if (endBound) {
    query = query.lte("timestamp", endBound);
  }

  const { data, error } = await query;

  if (error) {
    return sendSafeError(res, 500, "Failed to load climate readings.", "climate/readings select:", error);
  }

  return res.json(data ?? []);
});

export { router as climateReadingsRouter };
