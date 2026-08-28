// Shared fixture for HTTP-level tests that must pass through real
// requirePermission/requireAnyPermission middleware, which does a genuine
// memberships lookup — a fabricated user id gets a real 403, not just a
// stand-in. Denva is used across this suite as a shared, disposable QA
// organization with no guaranteed permanent human member (one was removed
// on 2026-08-28, breaking several tests that assumed "a real member always
// exists"), so this makes any such test self-sufficient instead of
// depending on that external, mutable state.
import { randomUUID } from "node:crypto";
import { supabase } from "../../../config/supabase";

export type MembershipFixture = {
  userId: string;
  /**
   * Always safe to call from your suite's `after()` hook. A no-op when this
   * fixture only borrowed an existing real membership (never modifies or
   * deletes a real one); removes both the membership and the disposable
   * synthetic auth user when this fixture created them.
   */
  cleanup: () => Promise<void>;
};

/**
 * Returns a real (organizationId, userId) membership. Reuses any existing
 * real member if one exists. Otherwise creates a disposable synthetic auth
 * user + membership — memberships.user_id has a foreign key to auth.users,
 * so a fabricated UUID cannot be used here.
 */
export async function ensureRealMembership(
  organizationId: string,
  role: "owner" | "admin" | "member" = "owner"
): Promise<MembershipFixture> {
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  if (data?.user_id) {
    return { userId: data.user_id as string, cleanup: async () => {} };
  }

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: `test-fixture-${randomUUID()}@growlink.test`,
    email_confirm: true,
    user_metadata: { full_name: "Test Fixture" }
  });
  if (createErr || !created?.user) {
    throw new Error(`No real membership found for org ${organizationId}, and failed to create a disposable one: ${createErr?.message}`);
  }
  const userId = created.user.id;

  const { error: memErr } = await supabase
    .from("memberships")
    .insert({ organization_id: organizationId, user_id: userId, role, permissions: {} });
  if (memErr) {
    await supabase.auth.admin.deleteUser(userId).catch(() => {});
    throw new Error(`No real membership found for org ${organizationId}, and failed to attach one to a disposable user: ${memErr.message}`);
  }

  return {
    userId,
    cleanup: async () => {
      await supabase.from("memberships").delete().eq("organization_id", organizationId).eq("user_id", userId);
      await supabase.auth.admin.deleteUser(userId).catch(() => {});
    }
  };
}
