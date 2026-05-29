import { type NextFunction, type Request, type Response } from "express";
import { supabase } from "../config/supabase";

// ── internal helpers ──────────────────────────────────────────────────────────

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

// Queries only `role` — exists since migration 0017, always safe.
async function fetchRole(
  userId: string,
  organizationId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    console.error("requirePermission: role lookup error uid=%s org=%s", userId, organizationId, error);
    return null;
  }
  if (!data) {
    console.warn("requirePermission: no membership found uid=%s org=%s", userId, organizationId);
    return null;
  }
  return (data as { role: string }).role;
}

// Queries `permissions` separately — added in migration 0042.
// Returns {} if the column is missing (unapplied migration) so the role
// check above is never blocked by a missing column.
async function fetchPermissions(
  userId: string,
  organizationId: string
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from("memberships")
    .select("permissions")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    // Column likely doesn't exist yet — treat as empty, not as a hard failure.
    console.warn("requirePermission: permissions lookup unavailable uid=%s org=%s — %s", userId, organizationId, error.message);
    return {};
  }

  const raw = (data as { permissions?: unknown } | null)?.permissions;
  return isPlainObject(raw) ? raw : {};
}

// Core check: owner/admin bypass → then permissions[key] === true for any key.
async function hasPermission(
  userId: string,
  organizationId: string,
  permissionKeys: string[]
): Promise<boolean> {
  const role = await fetchRole(userId, organizationId);

  if (!role) return false;
  if (role === "owner" || role === "admin") return true;

  // Only hit the DB a second time for regular members.
  const permissions = await fetchPermissions(userId, organizationId);
  const granted = permissionKeys.some((key) => permissions[key] === true);

  console.log(
    "requirePermission: uid=%s org=%s role=%s keys=%s granted=%s",
    userId,
    organizationId,
    role,
    permissionKeys.join(","),
    granted
  );

  return granted;
}

// ── exported middleware factories ─────────────────────────────────────────────

/**
 * Express middleware factory. Must run after requireOrganizationContext so
 * req.userId and req.organizationId are already set.
 *
 * Owners and admins pass unconditionally.
 * Members must have memberships.permissions[permissionKey] === true.
 *
 * Usage in a route file:
 *   router.get("/foo", requirePermission("yield:view"), handler);
 */
export function requirePermission(permissionKey: string) {
  return async function permissionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    if (!req.userId) {
      return res.status(401).json({ message: "Authentication required." });
    }

    const allowed = await hasPermission(req.userId, req.organizationId, [permissionKey]);

    if (!allowed) {
      return res.status(403).json({ message: "You do not have permission to access this resource." });
    }

    return next();
  };
}

/**
 * Same as requirePermission but accepts multiple keys — passes if the user
 * holds *any* of them (OR logic). Useful for routes where either a view or
 * edit permission grants access.
 *
 * Usage:
 *   router.get("/foo", requireAnyPermission(["yield:view", "yield:edit"]), handler);
 */
export function requireAnyPermission(permissionKeys: string[]) {
  return async function anyPermissionMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    if (!req.userId) {
      return res.status(401).json({ message: "Authentication required." });
    }

    const allowed = await hasPermission(req.userId, req.organizationId, permissionKeys);

    if (!allowed) {
      return res.status(403).json({ message: "You do not have permission to access this resource." });
    }

    return next();
  };
}
