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
      .select("id, organization_id, label, status, created_at, last_used_at, data_source_type, updated_at, updated_by")
      .order("created_at", { ascending: false });

    if (keysError) {
      return sendSafeError(
        res, 500,
        "Failed to load upload keys.",
        "Upload key list error:",
        keysError
      );
    }

    const keyIds = (keys ?? []).map((k) => k.id);
    const templateKeyIds = new Set<string>();
    if (keyIds.length > 0) {
      const { data: templates } = await supabase
        .from("import_source_templates")
        .select("upload_key_id")
        .in("upload_key_id", keyIds);
      for (const t of templates ?? []) {
        templateKeyIds.add(t.upload_key_id as string);
      }
    }

    const organizationIds = Array.from(
      new Set((keys ?? []).map(key => key.organization_id).filter(Boolean))
    );

    // Orgs with at least one active, current csv_mapping_templates row —
    // lets the UI pre-emptively disable/warn on the csv_template option
    // rather than only finding out after a rejected PATCH.
    const orgsWithActiveCsvTemplate = new Set<string>();
    if (organizationIds.length > 0) {
      const { data: activeTemplates } = await supabase
        .from("csv_mapping_templates")
        .select("organization_id")
        .in("organization_id", organizationIds)
        .eq("is_current", true)
        .eq("is_active", true);
      for (const t of activeTemplates ?? []) {
        orgsWithActiveCsvTemplate.add(t.organization_id as string);
      }
    }

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
        dataSourceType: key.data_source_type ?? "flowmaster",
        hasTemplate: templateKeyIds.has(key.id),
        hasActiveCsvTemplate: orgsWithActiveCsvTemplate.has(key.organization_id),
        createdAt: key.created_at,
        lastUsedAt: key.last_used_at,
        updatedAt: key.updated_at ?? null,
        updatedBy: key.updated_by ?? null
      }))
    });
  }
);

adminUploadKeysRouter.post(
  "/admin/upload-keys",
  requireAdminUser,
  async (req: Request, res: Response) => {
    const { organizationId, label, dataSourceType } = req.body as Record<string, unknown>;

    if (typeof organizationId !== "string" || !organizationId.trim()) {
      return res.status(400).json({ message: "organizationId is required." });
    }

    if (typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ message: "label is required." });
    }

    const orgId = organizationId.trim();
    const keyLabel = label.trim();
    const allowedTypes = ["flowmaster", "generic_csv", "csv_template"] as const;
    const sourceType =
      typeof dataSourceType === "string" &&
      allowedTypes.includes(dataSourceType as typeof allowedTypes[number])
        ? (dataSourceType as typeof allowedTypes[number])
        : "flowmaster";

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
        status: "active",
        data_source_type: sourceType
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
      dataSourceType: sourceType,
      createdAt: inserted.created_at,
      key: rawKey
    });
  }
);

export const UPLOAD_KEY_DATA_SOURCE_TYPES = ["flowmaster", "generic_csv", "csv_template"] as const;
export type UploadKeyDataSourceType = (typeof UPLOAD_KEY_DATA_SOURCE_TYPES)[number];

export class UploadKeyValidationError extends Error {}
export class UploadKeyNotFoundError extends Error {}
export class UploadKeyNoActiveTemplateError extends Error {
  organizationId: string;
  constructor(message: string, organizationId: string) {
    super(message);
    this.organizationId = organizationId;
  }
}

export type UpdateDataSourceTypeResult = {
  id: string;
  dataSourceType: UploadKeyDataSourceType;
  unchanged: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

/**
 * Core logic for changing an existing upload key's data_source_type,
 * exported so it's directly testable without needing a real admin auth
 * session (see the integration tests — requireAdminUser needs a live
 * Supabase-issued JWT for a user id baked into ADMIN_USER_IDS at process
 * startup, which can't be fabricated in a test). Never touches key_hash —
 * the raw key is never regenerated or returned by this path.
 */
export async function updateUploadKeyDataSourceType(
  keyId: string,
  dataSourceType: unknown,
  adminUserId: string | null
): Promise<UpdateDataSourceTypeResult> {
  if (
    typeof dataSourceType !== "string" ||
    !UPLOAD_KEY_DATA_SOURCE_TYPES.includes(dataSourceType as UploadKeyDataSourceType)
  ) {
    throw new UploadKeyValidationError(`dataSourceType must be one of: ${UPLOAD_KEY_DATA_SOURCE_TYPES.join(", ")}`);
  }

  const { data: existing, error: existingError } = await supabase
    .from("organization_upload_keys")
    .select("id, organization_id, label, data_source_type")
    .eq("id", keyId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (!existing) throw new UploadKeyNotFoundError("Upload key not found.");

  if (existing.data_source_type === dataSourceType) {
    return { id: existing.id, dataSourceType: existing.data_source_type as UploadKeyDataSourceType, unchanged: true, updatedAt: null, updatedBy: null };
  }

  if (dataSourceType === "csv_template") {
    const { count, error: templateCheckError } = await supabase
      .from("csv_mapping_templates")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", existing.organization_id)
      .eq("is_current", true)
      .eq("is_active", true);

    if (templateCheckError) throw templateCheckError;

    if (!count || count === 0) {
      throw new UploadKeyNoActiveTemplateError(
        "This organization has no active CSV template yet. Ask them to create and approve one " +
          "in Yield Data Entry → CSV Templates before switching this key.",
        existing.organization_id
      );
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("organization_upload_keys")
    .update({
      data_source_type: dataSourceType,
      updated_at: new Date().toISOString(),
      updated_by: adminUserId
    })
    .eq("id", keyId)
    .select("id, data_source_type, updated_at, updated_by")
    .single();

  if (updateError || !updated) throw updateError ?? new Error("Failed to update upload key.");

  console.log(
    `Admin upload key data_source_type changed: key_id=${keyId} label="${existing.label}" ` +
      `${existing.data_source_type} -> ${dataSourceType} by user=${adminUserId ?? "(unknown)"}`
  );

  return {
    id: updated.id,
    dataSourceType: updated.data_source_type as UploadKeyDataSourceType,
    unchanged: false,
    updatedAt: updated.updated_at,
    updatedBy: updated.updated_by
  };
}

// PATCH /admin/upload-keys/:id/data-source-type
// Changes an EXISTING key's routing without regenerating or exposing the
// raw key value. Switching to 'csv_template' is blocked unless the
// organization already has an active (current + active) saved template —
// otherwise a csv_template key would immediately start dropping every CSV
// into "needs_template" with nothing to actually process it.
adminUploadKeysRouter.patch(
  "/admin/upload-keys/:id/data-source-type",
  requireAdminUser,
  async (req: Request, res: Response) => {
    try {
      const result = await updateUploadKeyDataSourceType(String(req.params.id), req.body?.dataSourceType, req.userId ?? null);
      return res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof UploadKeyValidationError) {
        return res.status(400).json({ message: error.message });
      }
      if (error instanceof UploadKeyNotFoundError) {
        return res.status(404).json({ message: error.message });
      }
      if (error instanceof UploadKeyNoActiveTemplateError) {
        return res.status(409).json({
          message: error.message,
          code: "no_active_template",
          organizationId: error.organizationId
        });
      }
      return sendSafeError(res, 500, "Failed to update upload key.", "Upload key data-source-type update error:", error);
    }
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

adminUploadKeysRouter.delete(
  "/admin/upload-keys/:id",
  requireAdminUser,
  async (req: Request, res: Response) => {
    const keyId = req.params.id;

    if (typeof keyId !== "string" || keyId.trim().length === 0) {
      return res.status(400).json({ message: "Upload key id is required." });
    }

    const { data: existing, error: existingError } = await supabase
      .from("organization_upload_keys")
      .select("id, status, label")
      .eq("id", keyId.trim())
      .maybeSingle();

    if (existingError) {
      return sendSafeError(
        res, 500,
        "Failed to load upload key.",
        "Upload key delete lookup error:",
        existingError
      );
    }

    if (!existing) {
      return res.status(404).json({ message: "Upload key not found." });
    }

    if (existing.status === "active") {
      return res.status(400).json({ message: "Cannot delete an active upload key. Revoke it first." });
    }

    const { error: templateDeleteError } = await supabase
      .from("import_source_templates")
      .delete()
      .eq("upload_key_id", existing.id);

    if (templateDeleteError) {
      return sendSafeError(
        res, 500,
        "Failed to remove import template.",
        "Upload key template delete error:",
        templateDeleteError
      );
    }

    const { error: deleteError } = await supabase
      .from("organization_upload_keys")
      .delete()
      .eq("id", existing.id);

    if (deleteError) {
      return sendSafeError(
        res, 500,
        "Failed to delete upload key.",
        "Upload key delete error:",
        deleteError
      );
    }

    console.log(`Admin upload key deleted: key_id=${existing.id} label="${existing.label}"`);

    return res.json({ success: true, id: existing.id });
  }
);

export { adminUploadKeysRouter };
