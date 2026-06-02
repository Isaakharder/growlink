import { useEffect, useState, type CSSProperties } from "react";
import { apiFetch } from "../lib/api";

type CustomerRow = {
  id: string;
  name: string;
  createdAt: string;
  lastActivityAt: string | null;
  memberCount: number;
  ownerEmail: string | null;
  ownerRole: string | null;
  ownersCount: number;
};

function OwnerRoleBadge({ role, ownersCount }: { role: string | null; ownersCount: number }) {
  if (!role) {
    return <span style={missingBadgeStyle}>Missing owner</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
      <span style={ownerBadgeStyle}>{role}</span>
      {ownersCount > 1 && (
        <span style={warnBadgeStyle} title={`${ownersCount} owner rows`}>
          ×{ownersCount}
        </span>
      )}
    </span>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString();
}

export function PlatformCustomersPage() {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadCustomers();
  }, []);

  async function loadCustomers() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/customers");
      const body = (await res.json().catch(() => ({}))) as {
        customers?: CustomerRow[];
        message?: string;
      };

      if (!res.ok) {
        setError(
          typeof body.message === "string" ? body.message : "Failed to load customers."
        );
        return;
      }

      setCustomers(Array.isArray(body.customers) ? body.customers : []);
    } catch {
      setError("Network error while loading customers.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "1.5rem 1rem 2rem" }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h1 style={titleStyle}>Customers</h1>
        <p style={descriptionStyle}>
          All organizations using the platform. Only visible to platform admins.
        </p>
      </div>

      {error && <p style={errorBannerStyle}>{error}</p>}

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
          <h2 style={sectionTitleStyle}>
            Organizations
            {!loading && (
              <span style={countBadgeStyle}>{customers.length}</span>
            )}
          </h2>
          <button
            type="button"
            onClick={() => void loadCustomers()}
            disabled={loading}
            style={secondaryButtonStyle}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>

        {loading ? (
          <p style={mutedTextStyle}>Loading customers...</p>
        ) : customers.length === 0 ? (
          <p style={mutedTextStyle}>No organizations found.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Organization</th>
                  <th style={thStyle}>Owner Email</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Members</th>
                  <th style={thStyle}>Created</th>
                  <th style={thStyle}>Last Activity</th>
                </tr>
              </thead>
              <tbody>
                {customers.map(row => (
                  <tr key={row.id}>
                    <td style={tdStyle}>{row.name}</td>
                    <td style={tdStyle}>{row.ownerEmail ?? "-"}</td>
                    <td style={tdStyle}>
                      <OwnerRoleBadge role={row.ownerRole} ownersCount={row.ownersCount} />
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>{row.memberCount}</td>
                    <td style={tdStyle}>{formatDate(row.createdAt)}</td>
                    <td style={tdStyle}>{formatDate(row.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const titleStyle: CSSProperties = {
  fontSize: "1.3rem",
  fontWeight: 700,
  margin: 0,
  color: "var(--text)"
};

const sectionTitleStyle: CSSProperties = {
  fontSize: "1rem",
  fontWeight: 600,
  margin: 0,
  color: "var(--text)",
  display: "flex",
  alignItems: "center",
  gap: "0.4rem"
};

const descriptionStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "0.85rem",
  margin: "0.25rem 0 0"
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "0.9rem"
};

const errorBannerStyle: CSSProperties = {
  margin: "0 0 0.75rem",
  padding: "0.55rem 0.7rem",
  background: "#fdf2f2",
  border: "1px solid #f5c6c6",
  borderRadius: 6,
  fontSize: "0.82rem",
  color: "#c0392b"
};

const mutedTextStyle: CSSProperties = {
  margin: "0.25rem 0",
  color: "var(--text-muted)",
  fontSize: "0.875rem"
};

const secondaryButtonStyle: CSSProperties = {
  padding: "0.38rem 0.65rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.8rem",
  fontWeight: 500
};

const countBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--surface-soft)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "0 0.45rem",
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "var(--text-muted)",
  minWidth: "1.4rem"
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.83rem"
};

const thStyle: CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-muted)",
  fontWeight: 600,
  padding: "0.45rem"
};

const tdStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  padding: "0.45rem",
  verticalAlign: "middle"
};

const ownerBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  fontWeight: 600,
  background: "#e8f8ef",
  color: "#1f7a42",
  border: "1px solid #bfe9cf"
};

const missingBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  fontWeight: 600,
  background: "var(--surface-soft)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)"
};

const warnBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.4rem",
  fontSize: "0.68rem",
  fontWeight: 700,
  background: "#fff7e6",
  color: "#7f5a00",
  border: "1px solid #f2d39b",
  cursor: "default"
};
