import { useCallback } from "react";
import { useMembership } from "../contexts/MembershipContext";

export type PermissionsHook = {
  loading: boolean;
  isOwnerOrAdmin: boolean;
  can: (permission: string) => boolean;
  canAny: (permissions: string[]) => boolean;
};

export function usePermissions(): PermissionsHook {
  const { loading, role, permissions } = useMembership();

  const isOwnerOrAdmin = role === "owner" || role === "admin";

  // While loading we return true so nav items don't flash-disappear on mount.
  // RequirePermission guards the actual page content with an explicit loading
  // check, so this optimistic return does not leak restricted content.
  const can = useCallback(
    (permission: string): boolean => {
      if (loading) return true;
      if (role === "owner" || role === "admin") return true;
      return permissions[permission] === true;
    },
    [loading, role, permissions]
  );

  const canAny = useCallback(
    (keys: string[]): boolean => {
      if (loading) return true;
      if (role === "owner" || role === "admin") return true;
      return keys.some((k) => permissions[k] === true);
    },
    [loading, role, permissions]
  );

  return { loading, isOwnerOrAdmin, can, canAny };
}
