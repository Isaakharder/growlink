import { Router, Request, Response } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requireAdminUser } from "../middleware/requireAdminUser";

const adminOrganizationsRouter = Router();

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

adminOrganizationsRouter.post(
  "/admin/organizations/create",
  requireAdminUser,
  async (req: Request, res: Response) => {
    const { organizationName, ownerEmail, ownerName } = req.body as Record<string, unknown>;

    if (
      typeof organizationName !== "string" ||
      organizationName.trim().length === 0
    ) {
      return res.status(400).json({ message: "Organization name is required." });
    }

    if (
      typeof ownerEmail !== "string" ||
      !isValidEmail(ownerEmail.trim())
    ) {
      return res.status(400).json({ message: "A valid owner email is required." });
    }

    const name = organizationName.trim();
    const email = ownerEmail.trim().toLowerCase();
    const fullName =
      typeof ownerName === "string" && ownerName.trim().length > 0
        ? ownerName.trim()
        : undefined;

    // 1. Create the organization row
    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .insert({ name })
      .select("id")
      .single();

    if (orgError || !org) {
      return sendSafeError(
        res, 500,
        "Failed to create organization.",
        "Admin org creation error:",
        orgError
      );
    }

    const organizationId: string = org.id;

    // 2. Invite the owner — creates auth user and sends Supabase invite email
    const inviteRedirectTo = process.env.SUPABASE_INVITE_REDIRECT_TO;
    const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
      email,
      {
        redirectTo:
          typeof inviteRedirectTo === "string" && inviteRedirectTo.trim().length > 0
            ? inviteRedirectTo.trim()
            : undefined,
        data: {
          ...(fullName ? { full_name: fullName } : {}),
          mustSetPassword: true
        }
      }
    );

    if (inviteError || !inviteData?.user) {
      // Temporary debug logging to capture the exact Supabase Admin API error.
      console.error("Supabase inviteUserByEmail exact error:", {
        message: inviteError?.message,
        status: inviteError?.status,
        code: inviteError?.code,
        name: inviteError?.name,
        full: inviteError
      });
      // Roll back org so we don't leave an orphaned organization row
      await supabase.from("organizations").delete().eq("id", organizationId);
      return sendSafeError(
        res, 500,
        "Failed to send invite. Organization was not created.",
        "Admin invite error:",
        inviteError
      );
    }

    const userId: string = inviteData.user.id;

    // 3. Create the owner membership
    const { error: membershipError } = await supabase
      .from("memberships")
      .insert({
        organization_id: organizationId,
        user_id: userId,
        role: "owner"
      });

    if (membershipError) {
      // Roll back: delete the invited user (cascades membership) then the org
      await supabase.auth.admin.deleteUser(userId);
      await supabase.from("organizations").delete().eq("id", organizationId);
      return sendSafeError(
        res, 500,
        "Failed to create organization membership. Organization was not created.",
        "Admin membership creation error:",
        membershipError
      );
    }

    console.log(
      `Admin org created: org=${organizationId} name="${name}" owner=${userId} email=${email}`
    );

    return res.status(201).json({
      success: true,
      message: `Invite sent to ${email}`,
      organizationId,
      organizationName: name
    });
  }
);

export { adminOrganizationsRouter };
