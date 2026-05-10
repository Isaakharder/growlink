import { NextFunction, Request, Response } from "express";
import { supabase } from "../config/supabase";

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

// Read at startup so a missing/misconfigured env var locks the endpoint immediately
// rather than silently allowing access.
function buildAdminUserIds(): Set<string> {
  const ids = new Set<string>();
  const raw = process.env.ADMIN_USER_IDS ?? "";
  for (const id of raw.split(",")) {
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids;
}

const adminUserIds = buildAdminUserIds();

export async function requireAdminUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (adminUserIds.size === 0) {
    return res.status(503).json({
      message: "Admin access is not configured on this server."
    });
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ message: "Authentication is required." });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ message: "Failed to resolve authenticated user session." });
  }

  if (!adminUserIds.has(data.user.id)) {
    return res.status(403).json({ message: "Access denied." });
  }

  req.userId = data.user.id;
  return next();
}
