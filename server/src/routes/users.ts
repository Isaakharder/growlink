import { Router, Request, Response } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission } from "../middleware/requirePermission";

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

const VALID_ROLES = ["owner", "admin", "member"] as const;
type MemberRole = (typeof VALID_ROLES)[number];

type MembershipRow = {
  id: string;
  user_id: string;
  role: string;
  position: string | null;
  permissions: unknown;
  created_at: string;
};

const usersRouter = Router();

// requirePermission("admin:invite_users") short-circuits for owner/admin,
// then checks permissions["admin:invite_users"] === true for members.
// Reusing the same gate as invite management — user managers need the same access.
const canManageUsers = requirePermission("admin:invite_users");

// GET /api/users — list all members in the current organization
usersRouter.get("/users", canManageUsers, async (req: Request, res: Response) => {
  const { organizationId } = req;

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("id, user_id, role, position, permissions, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (membershipError) {
    return sendSafeError(res, 500, "Failed to load users.", "Users fetch error:", membershipError);
  }

  if (!memberships || memberships.length === 0) {
    return res.json({ users: [] });
  }

  // Fetch auth user data (email, display name) for each member individually.
  // Org membership lists are small so N calls is acceptable and avoids leaking
  // other orgs' user data that listUsers() would include.
  const authResults = await Promise.all(
    (memberships as MembershipRow[]).map(async (m) => {
      const { data } = await supabase.auth.admin.getUserById(m.user_id);
      return {
        userId: m.user_id,
        email: data.user?.email ?? null,
        displayName:
          typeof data.user?.user_metadata?.full_name === "string" &&
          data.user.user_metadata.full_name.trim()
            ? data.user.user_metadata.full_name.trim()
            : null,
      };
    })
  );

  const authMap = new Map(authResults.map((r) => [r.userId, r]));

  const users = (memberships as MembershipRow[]).map((m) => {
    const auth = authMap.get(m.user_id);
    return {
      membershipId: m.id,
      userId: m.user_id,
      email: auth?.email ?? null,
      displayName: auth?.displayName ?? null,
      role: m.role,
      position: m.position ?? null,
      permissions: isPlainObject(m.permissions) ? m.permissions : {},
      createdAt: m.created_at,
    };
  });

  return res.json({ users });
});

// PATCH /api/users/:membershipId — update role, position, or permissions
usersRouter.patch("/users/:membershipId", canManageUsers, async (req: Request, res: Response) => {
  const { organizationId } = req;
  const membershipId = req.params.membershipId as string;
  const body = req.body as Record<string, unknown>;

  const { data: membership, error: fetchError } = await supabase
    .from("memberships")
    .select("id, user_id, role")
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(res, 500, "Failed to load membership.", "Users PATCH fetch error:", fetchError);
  }
  if (!membership) {
    return res.status(404).json({ message: "User not found in this organization." });
  }

  const mem = membership as { id: string; user_id: string; role: string };
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("role" in body) {
    const newRole = typeof body.role === "string" ? body.role : "";
    if (!VALID_ROLES.includes(newRole as MemberRole)) {
      return res.status(400).json({ message: "role must be owner, admin, or member." });
    }
    // Last-owner protection: block demoting the only remaining owner.
    if (mem.role === "owner" && newRole !== "owner") {
      const { count, error: countError } = await supabase
        .from("memberships")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("role", "owner");
      if (countError) {
        return sendSafeError(res, 500, "Failed to verify owner count.", "Users owner count error:", countError);
      }
      if ((count ?? 0) <= 1) {
        return res.status(409).json({ message: "Cannot demote the last owner of the organization." });
      }
    }
    updates.role = newRole;
  }

  if ("position" in body) {
    updates.position =
      typeof body.position === "string" && body.position.trim()
        ? body.position.trim()
        : null;
  }

  if ("permissions" in body) {
    updates.permissions = isPlainObject(body.permissions) ? body.permissions : {};
  }

  const { data, error: updateError } = await supabase
    .from("memberships")
    .update(updates)
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .select("id, user_id, role, position, permissions, created_at")
    .single();

  if (updateError) {
    return sendSafeError(res, 500, "Failed to update user.", "Users PATCH update error:", updateError);
  }

  return res.json({ membership: data });
});

// DELETE /api/users/:membershipId — remove a member from the organization
usersRouter.delete("/users/:membershipId", canManageUsers, async (req: Request, res: Response) => {
  const { organizationId, userId: requestingUserId } = req;
  const membershipId = req.params.membershipId as string;

  const { data: membership, error: fetchError } = await supabase
    .from("memberships")
    .select("id, user_id, role")
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (fetchError) {
    return sendSafeError(res, 500, "Failed to load membership.", "Users DELETE fetch error:", fetchError);
  }
  if (!membership) {
    return res.status(404).json({ message: "User not found in this organization." });
  }

  const mem = membership as { id: string; user_id: string; role: string };

  // Self-removal: blocked server-side regardless of frontend behaviour.
  if (mem.user_id === requestingUserId) {
    return res.status(403).json({ message: "You cannot remove yourself from the organization." });
  }

  // Last-owner protection: block deleting the only remaining owner.
  if (mem.role === "owner") {
    const { count, error: countError } = await supabase
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("role", "owner");
    if (countError) {
      return sendSafeError(res, 500, "Failed to verify owner count.", "Users owner count error:", countError);
    }
    if ((count ?? 0) <= 1) {
      return res.status(409).json({ message: "Cannot remove the last owner of the organization." });
    }
  }

  const { error: deleteError } = await supabase
    .from("memberships")
    .delete()
    .eq("id", membershipId)
    .eq("organization_id", organizationId);

  if (deleteError) {
    return sendSafeError(res, 500, "Failed to remove user.", "Users DELETE error:", deleteError);
  }

  return res.json({ success: true });
});

export { usersRouter };
