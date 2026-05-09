import { NextFunction, Request, Response } from "express";
import { supabase } from "../config/supabase";

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

async function requireOrganizationContext(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({ message: "Authentication is required." });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return res.status(401).json({ message: "Failed to resolve authenticated user session." });
  }

  const userId = data.user.id;

  const membershipResult = await supabase
    .from("memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipResult.error) {
    return res.status(500).json({ message: membershipResult.error.message });
  }

  if (!membershipResult.data?.organization_id) {
    return res.status(403).json({ message: "User is not assigned to an organization." });
  }

  req.userId = userId;
  req.organizationId = membershipResult.data.organization_id;

  return next();
}

export { requireOrganizationContext };