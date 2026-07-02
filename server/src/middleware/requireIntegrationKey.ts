import { createHash } from "crypto";
import { NextFunction, Request, Response } from "express";
import { supabase } from "../config/supabase";

function getIntegrationKeyHeader(req: Request): string | null {
  const key = req.headers["x-integration-key"];
  if (typeof key !== "string" || key.trim().length === 0) return null;
  return key.trim();
}

function hashIntegrationKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

// Factory so each integration route only accepts keys issued for that
// integration (e.g. a CropLink key cannot authenticate a future partner's
// endpoints even though both live in organization_integration_keys).
export function requireIntegrationKey(integrationName: string) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const rawKey = getIntegrationKeyHeader(req);
    if (!rawKey) {
      return res.status(401).json({ message: "X-Integration-Key header is required." });
    }

    const keyHash = hashIntegrationKey(rawKey);

    const { data, error } = await supabase
      .from("organization_integration_keys")
      .select("id, organization_id, integration_name")
      .eq("key_hash", keyHash)
      .eq("status", "active")
      .maybeSingle();

    if (error) {
      console.error("Integration key lookup error:", error);
      return res.status(500).json({ message: "Failed to validate integration key." });
    }

    if (!data || data.integration_name !== integrationName) {
      return res.status(401).json({ message: "Invalid or revoked integration key." });
    }

    req.organizationId = data.organization_id;
    req.integrationKeyId = data.id;
    req.integrationName = data.integration_name;

    // Fire-and-forget: update last_used_at without blocking the request.
    void supabase
      .from("organization_integration_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id)
      .then(
        () => {},
        (err: unknown) => console.error("Failed to update integration key last_used_at:", err)
      );

    return next();
  };
}
