import { createHash } from "crypto";
import { NextFunction, Request, RequestHandler, Response } from "express";

function getIntegrationKeyHeader(req: Request): string | null {
  const key = req.headers["x-integration-key"];
  if (typeof key !== "string" || key.trim().length === 0) return null;
  return key.trim();
}

export function hashIntegrationKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export interface IntegrationKeyRecord {
  id: string;
  organization_id: string;
  integration_name: string;
  /** null/undefined for keys issued before scopes existed — treated as v1 read-only. */
  scopes?: string[] | null;
}

export interface IntegrationKeyStore {
  /** Active key whose hash matches, or null. Throws on lookup failure. */
  findActiveByHash(keyHash: string): Promise<IntegrationKeyRecord | null>;
  touch(keyId: string): Promise<void>;
}

/** Scope every key had before scopes were introduced (the original v1 harvest-actuals read). */
export const LEGACY_DEFAULT_SCOPES = ["harvest-actuals:read"];

// Factory so each integration route only accepts keys issued for that
// integration (e.g. a CropLink key cannot authenticate a future partner's
// endpoints even though both live in organization_integration_keys), and —
// when `requiredScope` is given — only keys explicitly granted that scope.
// Raw keys are never stored or logged; only their SHA-256 hash is compared.
export function createIntegrationKeyMiddleware(store: IntegrationKeyStore, integrationName: string, requiredScope?: string): RequestHandler {
  return async function (req: Request, res: Response, next: NextFunction) {
    const rawKey = getIntegrationKeyHeader(req);
    if (!rawKey) {
      return res.status(401).json({ message: "X-Integration-Key header is required." });
    }

    let data: IntegrationKeyRecord | null;
    try {
      data = await store.findActiveByHash(hashIntegrationKey(rawKey));
    } catch (error) {
      console.error("Integration key lookup error:", error);
      return res.status(500).json({ message: "Failed to validate integration key." });
    }

    if (!data || data.integration_name !== integrationName) {
      return res.status(401).json({ message: "Invalid or revoked integration key." });
    }

    const scopes = data.scopes ?? LEGACY_DEFAULT_SCOPES;
    if (requiredScope && !scopes.includes(requiredScope)) {
      return res.status(403).json({ message: `Integration key lacks the ${requiredScope} scope.` });
    }

    req.organizationId = data.organization_id;
    req.integrationKeyId = data.id;
    req.integrationName = data.integration_name;
    req.integrationScopes = scopes;

    // Fire-and-forget: update last_used_at without blocking the request.
    void store.touch(data.id).catch((err: unknown) => console.error("Failed to update integration key last_used_at:", err));

    return next();
  };
}

/** True when PostgREST/Postgres reports that `column` doesn't exist (migration not applied yet). */
export function isMissingColumnError(error: { code?: string; message?: string } | null | undefined, column: string): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return (error.message ?? "").includes(column);
  return /does not exist/i.test(error.message ?? "") && (error.message ?? "").includes(column);
}

/**
 * Looks a key up including its scopes; before migration 0141 adds the
 * column, falls back to the original columns so existing (v1) keys keep
 * working — they then carry LEGACY_DEFAULT_SCOPES.
 */
export async function findKeyWithScopeFallback(
  select: (columns: string) => Promise<{ data: IntegrationKeyRecord | null; error: { code?: string; message?: string } | null }>
): Promise<IntegrationKeyRecord | null> {
  const withScopes = await select("id, organization_id, integration_name, scopes");
  if (!withScopes.error) return withScopes.data;
  if (!isMissingColumnError(withScopes.error, "scopes")) throw withScopes.error;
  const legacy = await select("id, organization_id, integration_name");
  if (legacy.error) throw legacy.error;
  return legacy.data ? { ...legacy.data, scopes: null } : null;
}

// Required lazily so modules (and tests) that only need the factory never
// load ../config/supabase, which throws without database credentials.
function supabaseKeyStore(): IntegrationKeyStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { supabase } = require("../config/supabase") as typeof import("../config/supabase");
  return {
    async findActiveByHash(keyHash) {
      return findKeyWithScopeFallback(async columns => {
        const { data, error } = await supabase
          .from("organization_integration_keys")
          .select(columns)
          .eq("key_hash", keyHash)
          .eq("status", "active")
          .maybeSingle();
        return { data: data as IntegrationKeyRecord | null, error };
      });
    },
    async touch(keyId) {
      const { error } = await supabase
        .from("organization_integration_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", keyId);
      if (error) throw error;
    }
  };
}

export function requireIntegrationKey(integrationName: string, requiredScope?: string): RequestHandler {
  let middleware: RequestHandler | null = null;
  return (req: Request, res: Response, next: NextFunction) => {
    middleware ??= createIntegrationKeyMiddleware(supabaseKeyStore(), integrationName, requiredScope);
    return middleware(req, res, next);
  };
}
