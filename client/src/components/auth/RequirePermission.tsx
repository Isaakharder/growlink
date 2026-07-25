import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import { useMembership } from "../../contexts/MembershipContext";
import { getDefaultRoute } from "../../utils/getDefaultRoute";

type Props = {
  // A single required permission, or a list where holding ANY one of them
  // grants access (mirrors the server's requireAnyPermission/canAny pattern
  // — e.g. mobile irrigation access is granted by mobile:irrigation OR
  // irrigation:view OR irrigation:edit).
  permission: string | string[];
  children: ReactNode;
};

// Renders children when the current user holds the required permission(s).
// Returns null while membership is loading to avoid a flash of restricted
// content; shows Unauthorized once loaded if access is denied.
export function RequirePermission({ permission, children }: Props) {
  const { loading, can, canAny } = usePermissions();

  if (loading) return null;
  const allowed = Array.isArray(permission) ? canAny(permission) : can(permission);
  if (!allowed) return <Unauthorized />;
  return <>{children}</>;
}

export function Unauthorized() {
  const { role, permissions } = useMembership();
  const home = getDefaultRoute(role, permissions);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "3.5rem 1.5rem",
        textAlign: "center",
        gap: "0.55rem",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "1.05rem",
          fontWeight: 600,
          color: "var(--text)",
        }}
      >
        You don't have access to this page.
      </p>
      <p
        style={{
          margin: 0,
          fontSize: "0.88rem",
          color: "var(--text-muted)",
        }}
      >
        Contact your organization owner to request access.
      </p>
      <Link
        to={home}
        style={{
          marginTop: "0.5rem",
          display: "inline-block",
          padding: "0.48rem 1.1rem",
          background: "var(--brand)",
          color: "#fff",
          borderRadius: 8,
          textDecoration: "none",
          fontSize: "0.875rem",
          fontWeight: 600,
        }}
      >
        Go to Home
      </Link>
    </div>
  );
}
