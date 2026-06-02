import { Router, Request, Response } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAdminUser } from "../middleware/requireAdminUser";

const adminCustomersRouter = Router();

// Lightweight endpoint the frontend uses to detect platform admin status.
// Returns 200 for platform admins (enforced by requireAdminUser), 401/403 otherwise.
adminCustomersRouter.get(
  "/admin/check",
  requireAdminUser,
  (_req: Request, res: Response) => {
    return res.json({ isPlatformAdmin: true });
  }
);

adminCustomersRouter.get(
  "/admin/customers",
  requireAdminUser,
  async (_req: Request, res: Response) => {
    const [orgsResult, membershipsResult, usersResult] = await Promise.all([
      supabase
        .from("organizations")
        .select("id, name, created_at, updated_at")
        .order("name", { ascending: true }),
      supabase
        .from("memberships")
        .select("organization_id, user_id, role"),
      supabase.auth.admin.listUsers({ perPage: 1000 })
    ]);

    if (orgsResult.error) {
      return sendSafeError(
        res, 500,
        "Failed to load organizations.",
        "Admin customers orgs error:",
        orgsResult.error
      );
    }
    if (membershipsResult.error) {
      return sendSafeError(
        res, 500,
        "Failed to load members.",
        "Admin customers memberships error:",
        membershipsResult.error
      );
    }
    if (usersResult.error) {
      return sendSafeError(
        res, 500,
        "Failed to load users.",
        "Admin customers users error:",
        usersResult.error
      );
    }

    const orgs = orgsResult.data ?? [];
    const memberships = membershipsResult.data ?? [];
    const authUsers = usersResult.data?.users ?? [];

    const emailById = new Map<string, string>();
    for (const u of authUsers) {
      if (u.id && u.email) emailById.set(u.id, u.email);
    }

    const customers = orgs.map(org => {
      const orgMemberships = memberships.filter(m => m.organization_id === org.id);
      const ownerRows = orgMemberships.filter(m => m.role === "owner");
      const owner = ownerRows[0] ?? null;
      return {
        id: org.id,
        name: org.name,
        createdAt: org.created_at,
        lastActivityAt: (org.updated_at as string | null) ?? null,
        memberCount: orgMemberships.length,
        ownerEmail: owner ? (emailById.get(owner.user_id) ?? null) : null,
        ownerRole: owner ? owner.role : null,
        ownersCount: ownerRows.length,
      };
    });

    return res.json({ success: true, customers });
  }
);

export { adminCustomersRouter };
