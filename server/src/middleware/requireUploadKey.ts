import { createHash } from "crypto";
import { NextFunction, Request, Response } from "express";
import { supabase } from "../config/supabase";

function getUploadKeyHeader(req: Request): string | null {
  const key = req.headers["x-upload-key"];
  if (typeof key !== "string" || key.trim().length === 0) return null;
  return key.trim();
}

function hashUploadKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export async function requireUploadKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const rawKey = getUploadKeyHeader(req);
  if (!rawKey) {
    return res.status(401).json({ message: "X-Upload-Key header is required." });
  }

  const keyHash = hashUploadKey(rawKey);

  const { data, error } = await supabase
    .from("organization_upload_keys")
    .select("id, organization_id, label, data_source_type")
    .eq("key_hash", keyHash)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    console.error("Upload key lookup error:", error);
    return res.status(500).json({ message: "Failed to validate upload key." });
  }

  if (!data) {
    return res.status(401).json({ message: "Invalid or revoked upload key." });
  }

  req.organizationId = data.organization_id;
  req.uploadKeyLabel = data.label;
  req.uploadKeyId = data.id;
  req.dataSourceType = data.data_source_type ?? "flowmaster";

  // Fire-and-forget: update last_used_at without blocking the request.
  // Use two-arg .then() because the Supabase builder returns PromiseLike, not Promise.
  void supabase
    .from("organization_upload_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(
      () => {},
      (err: unknown) => console.error("Failed to update upload key last_used_at:", err)
    );

  return next();
}
