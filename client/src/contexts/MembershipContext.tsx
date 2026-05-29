import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "../lib/supabase";

export type MembershipState = {
  loading: boolean;
  role: string | null;
  permissions: Record<string, boolean>;
  displayName: string | null;
  position: string | null;
};

const defaultState: MembershipState = {
  loading: true,
  role: null,
  permissions: {},
  displayName: null,
  position: null,
};

const MembershipContext = createContext<MembershipState>(defaultState);

export function MembershipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MembershipState>(defaultState);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setState({ loading: false, role: null, permissions: {}, displayName: null, position: null });
        return;
      }

      // Prefer full_name from user_metadata (set on invite acceptance), fall back to email.
      const displayName: string | null =
        typeof user.user_metadata?.full_name === "string" &&
        user.user_metadata.full_name.trim().length > 0
          ? user.user_metadata.full_name.trim()
          : (user.email ?? null);

      // Attempt to fetch role + migration-0042 columns (position, permissions).
      // If the migration hasn't been applied to the remote DB yet, PostgREST
      // returns an error for the unknown columns; we fall back to role-only.
      const { data, error } = await supabase
        .from("memberships")
        .select("role, position, permissions")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error || !data) {
        // Fallback: query only role (guaranteed since migration 0017).
        const { data: roleRow } = await supabase
          .from("memberships")
          .select("role")
          .eq("user_id", user.id)
          .maybeSingle();

        setState({
          loading: false,
          role: roleRow ? (roleRow as { role: string }).role : null,
          permissions: {},
          displayName,
          position: null,
        });
        return;
      }

      const row = data as {
        role: string;
        position?: string | null;
        permissions?: unknown;
      };

      const rawPerms = row.permissions;
      const permissions: Record<string, boolean> =
        rawPerms !== null &&
        typeof rawPerms === "object" &&
        !Array.isArray(rawPerms)
          ? (rawPerms as Record<string, boolean>)
          : {};

      setState({
        loading: false,
        role: row.role,
        permissions,
        displayName,
        position: row.position ?? null,
      });
    } catch {
      setState({
        loading: false,
        role: null,
        permissions: {},
        displayName: null,
        position: null,
      });
    }
  }

  return (
    <MembershipContext.Provider value={state}>
      {children}
    </MembershipContext.Provider>
  );
}

export function useMembership(): MembershipState {
  return useContext(MembershipContext);
}
