// Equipment QR token lookup + regeneration.
//
// Org-isolation is structural, not just conventional: the lookup query
// filters by qr_token AND organization_id in the SAME query, so a token
// that doesn't exist at all and a token that exists but belongs to a
// different organization both produce `data === null` — there is no code
// path here that can distinguish the two, so neither can leak whether a
// scanned code belongs to someone else's equipment.

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { supabase } from "../../config/supabase";
import { sendSafeError } from "../../utils/safeError";
import { requirePermission, requireAnyPermission } from "../../middleware/requirePermission";

const qrRouter = Router();

const canView = requireAnyPermission(["maintenance:view", "maintenance:edit", "mobile:maintenance"]);
const canEdit = requirePermission("maintenance:edit");

qrRouter.get("/maintenance/equipment/qr/:token", canView, async (req, res) => {
  const organizationId = req.organizationId;
  const token = String(req.params.token);

  const { data, error } = await supabase
    .from("maintenance_equipment")
    .select("*, category:maintenance_categories(id, name), location:maintenance_locations(id, name)")
    .eq("qr_token", token)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to look up equipment.", "Maintenance QR lookup error:", error);
  if (!data) return res.status(404).json({ message: "Equipment not found." });

  return res.json(data);
});

qrRouter.post("/maintenance/equipment/:id/qr/regenerate", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const id = String(req.params.id);

  const { data, error } = await supabase
    .from("maintenance_equipment")
    .update({ qr_token: randomUUID(), qr_token_created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: req.userId })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, qr_token, qr_token_created_at")
    .maybeSingle();

  if (error) return sendSafeError(res, 500, "Failed to regenerate QR code.", "Maintenance QR regenerate error:", error);
  if (!data) return res.status(404).json({ message: "Equipment not found." });
  return res.json(data);
});

export { qrRouter };
