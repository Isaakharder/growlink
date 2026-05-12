import { createHash, randomBytes } from "crypto";
import { Request, Response, Router } from "express";
import { requireAdminUser } from "../middleware/requireAdminUser";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";

const adminUploadKeysRouter = Router();

function hashUploadKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

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

export { adminUploadKeysRouter };
