import { createHash, randomBytes } from "crypto";
import { Request, Response, Router } from "express";
import { requireAdminUser } from "../middleware/requireAdminUser";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { isMissingColumnError } from "../middleware/requireIntegrationKey";

const adminIntegrationKeysRouter = Router();

const ALLOWED_INTEGRATIONS = ["croplink"] as const;
type IntegrationName = typeof ALLOWED_INTEGRATIONS[number];
const ALLOWED_SCOPES = ["harvest-actuals:read", "yield-detail:read"] as const;

function hashIntegrationKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

adminIntegrationKeysRouter.get(
  "/admin/integration-keys",
  requireAdminUser,
  async (_req: Request, res: Response) => {
    const listKeys = (columns: string) => supabase
      .from("organization_integration_keys")
      .select(columns)
      .order("created_at", { ascending: false });
    // Before migration 0141 there is no scopes column; list without it.
    let { data: keys, error: keysError } = await listKeys("id, organization_id, integration_name, label, scopes, status, created_at, last_used_at");
    if (isMissingColumnError(keysError, "scopes")) {
      ({ data: keys, error: keysError } = await listKeys("id, organization_id, integration_name, label, status, created_at, last_used_at"));
    }

    if (keysError) {
      return sendSafeError(
        res, 500,
        "Failed to load integration keys.",
        "Integration key list error:",
        keysError
      );
    }

    const organizationIds = Array.from(
      new Set(((keys ?? []) as unknown as Array<{ organization_id: string }>).map(key => key.organization_id).filter(Boolean))
    );

    const organizationsById = new Map<string, string>();
    if (organizationIds.length > 0) {
      const { data: organizations, error: orgError } = await supabase
        .from("organizations")
        .select("id, name")
        .in("id", organizationIds);

      if (orgError) {
        return sendSafeError(
          res, 500,
          "Failed to resolve organization names.",
          "Integration key organization lookup error:",
          orgError
        );
      }

      for (const org of organizations ?? []) {
        organizationsById.set(org.id, org.name);
      }
    }

    return res.json({
      success: true,
      keys: ((keys ?? []) as unknown as Array<{ id: string; organization_id: string; integration_name: string; label: string; scopes?: string[] | null; status: string; created_at: string; last_used_at: string | null }>).map(key => ({
        id: key.id,
        organizationId: key.organization_id,
        organizationName: organizationsById.get(key.organization_id) ?? "Unknown",
        integrationName: key.integration_name,
        label: key.label,
        scopes: key.scopes ?? ["harvest-actuals:read"],
        status: key.status,
        createdAt: key.created_at,
        lastUsedAt: key.last_used_at
      }))
    });
  }
);

adminIntegrationKeysRouter.post(
  "/admin/integration-keys",
  requireAdminUser,
  async (req: Request, res: Response) => {
    const { organizationId, label, integrationName, scopes } = req.body as Record<string, unknown>;

    if (typeof organizationId !== "string" || !organizationId.trim()) {
      return res.status(400).json({ message: "organizationId is required." });
    }

    if (typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ message: "label is required." });
    }

    if (
      typeof integrationName !== "string" ||
      !ALLOWED_INTEGRATIONS.includes(integrationName as IntegrationName)
    ) {
      return res.status(400).json({
        message: `integrationName must be one of: ${ALLOWED_INTEGRATIONS.join(", ")}`
      });
    }

    let keyScopes: string[] = ["harvest-actuals:read"];
    const scopesRequested = scopes !== undefined;
    if (scopesRequested) {
      if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(s => typeof s === "string" && (ALLOWED_SCOPES as readonly string[]).includes(s))) {
        return res.status(400).json({ message: `scopes must be a non-empty array of: ${ALLOWED_SCOPES.join(", ")}` });
      }
      keyScopes = Array.from(new Set(scopes as string[])).sort();
    }

    const orgId = organizationId.trim();
    const keyLabel = label.trim();

    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("id, name")
      .eq("id", orgId)
      .maybeSingle();

    if (orgError) {
      return sendSafeError(
        res, 500,
        "Failed to verify organization.",
        "Integration key org lookup error:",
        orgError
      );
    }

    if (!org) {
      return res.status(400).json({ message: "Organization not found." });
    }

    const rawKey = "gki_" + randomBytes(32).toString("hex");
    const keyHash = hashIntegrationKey(rawKey);

    const { data: inserted, error: insertError } = await supabase
      .from("organization_integration_keys")
      .insert({
        organization_id: orgId,
        integration_name: integrationName,
        key_hash: keyHash,
        label: keyLabel,
        // Omitted unless requested so key creation keeps working before
        // migration 0141 (the column then defaults to harvest-actuals:read).
        ...(scopesRequested ? { scopes: keyScopes } : {}),
        status: "active"
      })
      .select("id, label, created_at")
      .single();

    if (scopesRequested && isMissingColumnError(insertError, "scopes")) {
      return res.status(400).json({ message: "Key scopes need database migration 0141; create the key without scopes or apply the migration first." });
    }
    if (insertError || !inserted) {
      return sendSafeError(
        res, 500,
        "Failed to create integration key.",
        "Integration key insert error:",
        insertError
      );
    }

    console.log(
      `Admin integration key created: org=${orgId} integration=${integrationName} label="${keyLabel}" scopes=${keyScopes.join(",")} key_id=${inserted.id}`
    );

    return res.status(201).json({
      success: true,
      id: inserted.id,
      organizationId: orgId,
      integrationName,
      label: inserted.label,
      scopes: keyScopes,
      createdAt: inserted.created_at,
      key: rawKey
    });
  }
);

adminIntegrationKeysRouter.post(
  "/admin/integration-keys/:id/revoke",
  requireAdminUser,
  async (req: Request, res: Response) => {
    const keyId = req.params.id;

    if (typeof keyId !== "string" || keyId.trim().length === 0) {
      return res.status(400).json({ message: "Integration key id is required." });
    }

    const { data: existing, error: existingError } = await supabase
      .from("organization_integration_keys")
      .select("id, status")
      .eq("id", keyId.trim())
      .maybeSingle();

    if (existingError) {
      return sendSafeError(
        res, 500,
        "Failed to load integration key.",
        "Integration key revoke lookup error:",
        existingError
      );
    }

    if (!existing) {
      return res.status(404).json({ message: "Integration key not found." });
    }

    if (existing.status === "revoked") {
      return res.json({ success: true, id: existing.id, status: "revoked" });
    }

    const { error: revokeError } = await supabase
      .from("organization_integration_keys")
      .update({ status: "revoked" })
      .eq("id", existing.id);

    if (revokeError) {
      return sendSafeError(
        res, 500,
        "Failed to revoke integration key.",
        "Integration key revoke update error:",
        revokeError
      );
    }

    return res.json({ success: true, id: existing.id, status: "revoked" });
  }
);

adminIntegrationKeysRouter.delete(
  "/admin/integration-keys/:id",
  requireAdminUser,
  async (req: Request, res: Response) => {
    const keyId = req.params.id;

    if (typeof keyId !== "string" || keyId.trim().length === 0) {
      return res.status(400).json({ message: "Integration key id is required." });
    }

    const { data: existing, error: existingError } = await supabase
      .from("organization_integration_keys")
      .select("id, status, label")
      .eq("id", keyId.trim())
      .maybeSingle();

    if (existingError) {
      return sendSafeError(
        res, 500,
        "Failed to load integration key.",
        "Integration key delete lookup error:",
        existingError
      );
    }

    if (!existing) {
      return res.status(404).json({ message: "Integration key not found." });
    }

    if (existing.status === "active") {
      return res.status(400).json({ message: "Cannot delete an active integration key. Revoke it first." });
    }

    const { error: deleteError } = await supabase
      .from("organization_integration_keys")
      .delete()
      .eq("id", existing.id);

    if (deleteError) {
      return sendSafeError(
        res, 500,
        "Failed to delete integration key.",
        "Integration key delete error:",
        deleteError
      );
    }

    console.log(`Admin integration key deleted: key_id=${existing.id} label="${existing.label}"`);

    return res.json({ success: true, id: existing.id });
  }
);

export { adminIntegrationKeysRouter };
