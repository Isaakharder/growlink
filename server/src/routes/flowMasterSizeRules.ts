import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import { type SizeRuleAction } from "../utils/flowMasterSizeRules";

const SIZE_RULE_ACTIONS: SizeRuleAction[] = ["create", "map", "ignore", "distribute"];

type SizeRulePayload = {
  raw_label: string;
  action: SizeRuleAction;
  target_size_id: string | null;
  distribute_size_ids: string[];
};

function parsePayload(input: unknown): SizeRulePayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body");
  }

  const body = input as Record<string, unknown>;
  const raw_label = typeof body.raw_label === "string" ? body.raw_label.trim() : "";
  if (!raw_label) {
    throw new Error("raw_label is required");
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!SIZE_RULE_ACTIONS.includes(action as SizeRuleAction)) {
    throw new Error("action must be one of: create, map, ignore, distribute");
  }

  const target_size_id =
    typeof body.target_size_id === "string" && body.target_size_id.trim()
      ? body.target_size_id.trim()
      : null;

  const distribute_size_ids = Array.isArray(body.distribute_size_ids)
    ? body.distribute_size_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  if ((action === "create" || action === "map") && !target_size_id) {
    throw new Error(`target_size_id is required for action "${action}"`);
  }

  if (action === "distribute" && distribute_size_ids.length === 0) {
    throw new Error("distribute_size_ids must include at least one destination size");
  }

  return {
    raw_label,
    action: action as SizeRuleAction,
    target_size_id: action === "create" || action === "map" ? target_size_id : null,
    distribute_size_ids: action === "distribute" ? distribute_size_ids : []
  };
}

const flowMasterSizeRulesRouter = Router();

const canView = requireAnyPermission(["yield:view", "yield:edit"]);
const canEdit = requirePermission("yield:edit");

flowMasterSizeRulesRouter.get("/flowmaster-size-rules", canView, async (req, res) => {
  const organizationId = req.organizationId;

  const { data, error } = await supabase
    .from("flowmaster_size_rules")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (error) {
    return sendSafeError(res, 500, "Failed to load size rules.", "Flowmaster size rules fetch error:", error);
  }

  return res.json(data ?? []);
});

// Upserts a rule by (organization_id, raw_label) — case/whitespace-insensitive
// via the raw_label_normalized generated column's unique constraint. Saving a
// rule for a label that already has one replaces it, so re-configuring a
// label from the setup UI is idempotent.
flowMasterSizeRulesRouter.post("/flowmaster-size-rules", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  let payload: SizeRulePayload;

  try {
    payload = parsePayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return res.status(400).json({ message });
  }

  const referencedSizeIds = Array.from(
    new Set([...(payload.target_size_id ? [payload.target_size_id] : []), ...payload.distribute_size_ids])
  );

  if (referencedSizeIds.length > 0) {
    const { data: matchedSizes, error: sizesError } = await supabase
      .from("yield_sizes")
      .select("id")
      .eq("organization_id", organizationId)
      .in("id", referencedSizeIds);

    if (sizesError) {
      return sendSafeError(res, 500, "Failed to validate target sizes.", "Flowmaster size rules validation error:", sizesError);
    }

    const matchedIds = new Set((matchedSizes ?? []).map((row) => row.id as string));
    const missing = referencedSizeIds.filter((id) => !matchedIds.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ message: "One or more target sizes do not belong to this organization." });
    }
  }

  const { data, error } = await supabase
    .from("flowmaster_size_rules")
    .upsert(
      {
        organization_id: organizationId,
        raw_label: payload.raw_label,
        action: payload.action,
        target_size_id: payload.target_size_id,
        distribute_size_ids: payload.distribute_size_ids,
        updated_at: new Date().toISOString()
      },
      { onConflict: "organization_id,raw_label_normalized" }
    )
    .select("*")
    .single();

  if (error) {
    return sendSafeError(res, 500, "Failed to save size rule.", "Flowmaster size rules upsert error:", error);
  }

  return res.status(201).json(data);
});

flowMasterSizeRulesRouter.delete("/flowmaster-size-rules/:id", canEdit, async (req, res) => {
  const organizationId = req.organizationId;
  const { id } = req.params;

  const { error } = await supabase
    .from("flowmaster_size_rules")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return sendSafeError(res, 500, "Failed to delete size rule.", "Flowmaster size rules delete error:", error);
  }

  return res.status(204).send();
});

export { flowMasterSizeRulesRouter };
