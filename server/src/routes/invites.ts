import crypto from "crypto";
import { Router, Request, Response } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission } from "../middleware/requirePermission";

// ── helpers ──────────────────────────────────────────────────────────────────

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function appBaseUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ── authorization ─────────────────────────────────────────────────────────────

async function canManageInvites(
  userId: string,
  organizationId: string
): Promise<boolean> {
  // Step 1: query only `role` — this column is guaranteed to exist (migration 0017).
  // Combining it with `permissions` in one select would silently return null if
  // the permissions column doesn't exist yet (migration 0042 not yet applied to
  // the remote DB), which would incorrectly deny owners and admins.
  const { data: roleData, error: roleError } = await supabase
    .from("memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (roleError) {
    console.error("canManageInvites: role lookup error uid=%s org=%s", userId, organizationId, roleError);
    return false;
  }

  if (!roleData) {
    console.warn("canManageInvites: no membership found uid=%s org=%s", userId, organizationId);
    return false;
  }

  const role = (roleData as { role: string }).role;
  console.log("canManageInvites: uid=%s org=%s role=%s", userId, organizationId, role);

  if (role === "owner" || role === "admin") return true;

  // Step 2: for members, check the permissions JSONB column.
  // Query separately so a missing column (migration not yet applied) returns an
  // error we can handle gracefully rather than blocking the role check above.
  const { data: permData, error: permError } = await supabase
    .from("memberships")
    .select("permissions")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (permError) {
    // permissions column likely not applied to this deployment yet — deny non-owners.
    console.warn("canManageInvites: permissions lookup error (column may be missing):", permError.message);
    return false;
  }

  const perms = (permData as { permissions?: unknown } | null)?.permissions;
  return isPlainObject(perms) && perms["admin:invite_users"] === true;
}

// ── public router ─────────────────────────────────────────────────────────────
// Mounted BEFORE requireOrganizationContext in app.ts so no auth is required.

const invitesPublicRouter = Router();

// GET /api/invites/validate?token=...
// Verifies a token is valid and returns safe invite info (no token_hash).
invitesPublicRouter.get("/invites/validate", async (req: Request, res: Response) => {
  const raw = req.query.token;

  if (typeof raw !== "string" || raw.trim().length === 0) {
    return res.status(400).json({ message: "token query parameter is required." });
  }

  const tokenHash = hashToken(raw.trim());

  const { data: invite, error } = await supabase
    .from("organization_invites")
    .select("email, position, expires_at, accepted_at, organization_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    return sendSafeError(res, 500, "Failed to validate invite.", "Invite validate error:", error);
  }

  if (!invite) {
    return res.status(404).json({ message: "Invite not found or already used." });
  }

  const inv = invite as {
    email: string;
    position: string | null;
    expires_at: string;
    accepted_at: string | null;
    organization_id: string;
  };

  if (inv.accepted_at) {
    return res.status(409).json({ message: "This invite has already been accepted." });
  }

  if (new Date(inv.expires_at) < new Date()) {
    return res.status(410).json({ message: "This invite has expired." });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", inv.organization_id)
    .maybeSingle();

  return res.json({
    email: inv.email,
    position: inv.position,
    organizationName: (org as { name: string } | null)?.name ?? null,
  });
});

// POST /api/invites/accept
// Creates a Supabase Auth user, creates their membership, and marks the invite accepted.
invitesPublicRouter.post("/invites/accept", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const { token, name, password } = body;

  if (typeof token !== "string" || token.trim().length === 0) {
    return res.status(400).json({ message: "token is required." });
  }

  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ message: "password must be at least 8 characters." });
  }

  const tokenHash = hashToken(token.trim());

  const { data: invite, error: inviteError } = await supabase
    .from("organization_invites")
    .select("id, email, position, permissions, expires_at, accepted_at, organization_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (inviteError) {
    return sendSafeError(res, 500, "Failed to look up invite.", "Invite accept lookup error:", inviteError);
  }

  if (!invite) {
    return res.status(404).json({ message: "Invite not found or already used." });
  }

  const inv = invite as {
    id: string;
    email: string;
    position: string | null;
    permissions: unknown;
    expires_at: string;
    accepted_at: string | null;
    organization_id: string;
  };

  if (inv.accepted_at) {
    return res.status(409).json({ message: "This invite has already been accepted." });
  }

  if (new Date(inv.expires_at) < new Date()) {
    return res.status(410).json({ message: "This invite has expired." });
  }

  const fullName =
    typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;

  // Create Auth user via service role — email_confirm:true skips the
  // verification email since the invite link already proves ownership.
  const { data: authData, error: createError } = await supabase.auth.admin.createUser({
    email: inv.email,
    password,
    user_metadata: fullName ? { full_name: fullName } : {},
    email_confirm: true,
  });

  if (createError || !authData?.user) {
    const msg = (createError?.message ?? "").toLowerCase();
    if (msg.includes("already") || msg.includes("exists") || msg.includes("registered")) {
      return res.status(409).json({
        message: "An account with this email already exists. Please sign in instead.",
      });
    }
    return sendSafeError(res, 500, "Failed to create account.", "Invite accept createUser error:", createError);
  }

  const userId = authData.user.id;

  const safePermissions = isPlainObject(inv.permissions) ? inv.permissions : {};

  const { error: membershipError } = await supabase.from("memberships").insert({
    organization_id: inv.organization_id,
    user_id: userId,
    role: "member",
    position: inv.position,
    permissions: safePermissions,
  });

  if (membershipError) {
    // Roll back the auth user so the invite remains usable on retry.
    await supabase.auth.admin.deleteUser(userId);
    return sendSafeError(res, 500, "Failed to create membership.", "Invite accept membership error:", membershipError);
  }

  // Best-effort — if this fails the user is already a valid member.
  await supabase
    .from("organization_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", inv.id);

  console.log(
    `Invite accepted: inviteId=${inv.id} org=${inv.organization_id} userId=${userId} email=${inv.email}`
  );

  return res.status(201).json({ success: true, message: "Account created successfully." });
});

// ── protected router ──────────────────────────────────────────────────────────
// Mounted AFTER requireOrganizationContext in app.ts — organizationId is guaranteed.

const invitesRouter = Router();

// POST /api/invites — create a new invite
invitesRouter.post("/invites", async (req: Request, res: Response) => {
  const { organizationId } = req;

  if (!req.userId) {
    return res.status(401).json({ message: "Authentication required." });
  }
  const userId = req.userId;

  if (!await canManageInvites(userId, organizationId)) {
    return res.status(403).json({ message: "You do not have permission to invite users." });
  }

  const body = req.body as Record<string, unknown>;
  const { email, position, permissions } = body;

  if (typeof email !== "string" || !isValidEmail(email.trim())) {
    return res.status(400).json({ message: "A valid email address is required." });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const safePosition =
    typeof position === "string" && position.trim().length > 0
      ? position.trim()
      : null;

  const safePermissions = isPlainObject(permissions) ? permissions : {};

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS).toISOString();

  const { data: invite, error } = await supabase
    .from("organization_invites")
    .insert({
      organization_id: organizationId,
      email: normalizedEmail,
      token_hash: tokenHash,
      position: safePosition,
      permissions: safePermissions,
      invited_by: userId,
      expires_at: expiresAt,
    })
    .select("id, email, position, expires_at, created_at")
    .single();

  if (error) {
    // 23505 = unique_violation; token collision is astronomically unlikely
    // but the email+org combination could appear if already invited.
    if (error.code === "23505") {
      return res.status(409).json({
        message: "A pending invite for this email address may already exist.",
      });
    }
    return sendSafeError(res, 500, "Failed to create invite.", "Invite insert error:", error);
  }

  const inviteUrl = `${appBaseUrl()}/invite/accept?token=${token}`;

  console.log(
    `Invite created: org=${organizationId} email=${normalizedEmail} by=${userId} expires=${expiresAt}`
  );

  return res.status(201).json({ success: true, invite, inviteUrl });
});

// GET /api/invites — list all invites for the current organization.
// requirePermission("admin:invite_users") is the first real-world test of the
// shared permission middleware; it replaces the previous inline canManageInvites
// call and produces identical semantics (owner/admin bypass + explicit permission).
invitesRouter.get("/invites", requirePermission("admin:invite_users"), async (req: Request, res: Response) => {
  const { organizationId } = req;

  const { data, error } = await supabase
    .from("organization_invites")
    .select("id, email, position, permissions, invited_by, expires_at, accepted_at, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    return sendSafeError(res, 500, "Failed to load invites.", "Invite list error:", error);
  }

  return res.json({ invites: data ?? [] });
});

export { invitesPublicRouter, invitesRouter };
