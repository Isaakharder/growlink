import { supabase } from "../../../config/supabase";

export type ActorIdentity = {
  userId: string;
  name: string;
  initials: string;
};

// "Isaak Harder" -> "IH", "José Martinez" -> "JM", single-word name -> first
// two letters. Never derived from client input — see resolveActor below.
export function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Resolves the acting employee's identity strictly from the authenticated
// Supabase session (req.userId) — the mobile client never supplies a name,
// initials, or employee id for completion/audit purposes.
export async function resolveActor(userId: string): Promise<ActorIdentity> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error || !data?.user) {
    throw new Error("Unable to resolve the logged-in user.");
  }

  const fullName =
    typeof data.user.user_metadata?.full_name === "string" ? data.user.user_metadata.full_name.trim() : "";
  const name = fullName || data.user.email?.split("@")[0] || "Unknown";

  return { userId, name, initials: deriveInitials(name) };
}
