import type { ReactNode } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { Unauthorized } from "./RequirePermission";

type Props = {
  permissions: string[];
  children: ReactNode;
};

// Same shape as RequirePermission, but grants access when the user holds
// ANY of the given permission keys — the client-side equivalent of the
// server's requireAnyPermission(keys) middleware. Use this whenever a
// backend route accepts more than one permission key for read access
// (e.g. "view" OR a narrower "manage_x" key), so the frontend route gate
// doesn't block a user the backend would otherwise allow through.
export function RequireAnyPermission({ permissions, children }: Props) {
  const { loading, canAny } = usePermissions();

  if (loading) return null;
  if (!canAny(permissions)) return <Unauthorized />;
  return <>{children}</>;
}
