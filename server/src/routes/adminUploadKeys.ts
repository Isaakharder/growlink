import { createHash, randomBytes } from "crypto";
import { Request, Response, Router } from "express";
import { requireAdminUser } from "../middleware/requireAdminUser";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";

const adminUploadKeysRouter = Router();

function hashUploadKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

adminUploadKeysRouter.get(
  "/admin/upload-keys",
  requireAdminUser,
  async (_req: Request, res: Response) => {
    const { data: keys, error: keysError } = await supabase
      .from("organization_upload_keys")
      .select("id, organization_id, label, status, created_at, last_used_at")
      .order("created_at", { ascending: false });

    if (keysError) {
      return sendSafeError(
        res, 500,
        "Failed to load upload keys.",
        "Upload key list error:",
        keysError
      );
    }

    const organizationIds = Array.from(
      new Set((keys ?? []).map(key => key.organization_id).filter(Boolean))
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
          "Upload key organization lookup error:",
          orgError
        );
      }

      for (const org of organizations ?? []) {
        organizationsById.set(org.id, org.name);
      }
    }

    return res.json({
      success: true,
      keys: (keys ?? []).map(key => ({
        id: key.id,
        organizationId: key.organization_id,
        organizationName: organizationsById.get(key.organization_id) ?? "Unknown",
        label: key.label,
        status: key.status,
        createdAt: key.created_at,
        lastUsedAt: key.last_used_at
      }))
    });
  }
);

adminUploadKeysRouter.post(
  "/admin/upload-keys",
  requireAdminUser,
  async (req: Request, res: Response) => {
    const { organizationId, label } = req.body as Record<string, unknown>;

    if (typeof organizationId !== "string" || !organizationId.trim()) {
      return res.status(400).json({ message: "organizationId is required." });
    }

    if (typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ message: "label is required." });
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
        "Upload key org lookup error:",
        orgError
      );
    }

    if (!org) {
      return res.status(400).json({ message: "Organization not found." });
    }

    const rawKey = "gk_" + randomBytes(32).toString("hex");
    const keyHash = hashUploadKey(rawKey);

    const { data: inserted, error: insertError } = await supabase
      .from("organization_upload_keys")
      .insert({
        organization_id: orgId,
        key_hash: keyHash,
        label: keyLabel,
        status: "active"
      })
      .select("id, label, created_at")
      .single();

    if (insertError || !inserted) {
      return sendSafeError(
        res, 500,
        "Failed to create upload key.",
        "Upload key insert error:",
        insertError
      );
    }

    console.log(
      `Admin upload key created: org=${orgId} label="${keyLabel}" key_id=${inserted.id}`
    );

    return res.status(201).json({
      success: true,
      id: inserted.id,
      organizationId: orgId,
      label: inserted.label,
      createdAt: inserted.created_at,
      key: rawKey
    });
  }
);

adminUploadKeysRouter.post(
  "/admin/upload-keys/:id/revoke",
  requireAdminUser,
  async (req: Request, res: Response) => {
    const keyId = req.params.id;

    if (typeof keyId !== "string" || keyId.trim().length === 0) {
      return res.status(400).json({ message: "Upload key id is required." });
    }

    const { data: existing, error: existingError } = await supabase
      .from("organization_upload_keys")
      .select("id, status")
      .eq("id", keyId.trim())
      .maybeSingle();

    if (existingError) {
      return sendSafeError(
        res, 500,
        "Failed to load upload key.",
        "Upload key revoke lookup error:",
        existingError
      );
    }

    if (!existing) {
      return res.status(404).json({ message: "Upload key not found." });
    }

    if (existing.status === "revoked") {
      return res.json({ success: true, id: existing.id, status: "revoked" });
    }

    const { error: revokeError } = await supabase
      .from("organization_upload_keys")
      .update({ status: "revoked" })
      .eq("id", existing.id);

    if (revokeError) {
      return sendSafeError(
        res, 500,
        "Failed to revoke upload key.",
        "Upload key revoke update error:",
        revokeError
      );
    }

    return res.json({ success: true, id: existing.id, status: "revoked" });
  }
);

export { adminUploadKeysRouter };
