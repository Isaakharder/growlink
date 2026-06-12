import { FormEvent, useEffect, useState, type CSSProperties } from "react";
import { apiFetch } from "../lib/api";

type SubmitState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; email: string; orgName: string }
  | { kind: "error"; message: string };

type OrganizationRow = {
  id: string;
  name: string;
  createdAt: string;
};

function getResponseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const maybeMessage = (body as { message?: unknown }).message;
  return typeof maybeMessage === "string" && maybeMessage.trim().length > 0
    ? maybeMessage
    : fallback;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

export function AdminOrganizationsPage() {
  const [orgName, setOrgName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [orgsError, setOrgsError] = useState<string | null>(null);

  useEffect(() => {
    void loadOrganizations();
  }, []);

  async function loadOrganizations() {
    setOrgsLoading(true);
    setOrgsError(null);
    try {
      const res = await apiFetch("/api/admin/organizations");
      const body = (await res.json().catch(() => ({}))) as {
        organizations?: OrganizationRow[];
      };
      if (!res.ok) {
        setOrgsError(getResponseMessage(body, "Failed to load organizations."));
        return;
      }
      setOrganizations(Array.isArray(body.organizations) ? body.organizations : []);
    } catch {
      setOrgsError("Network error while loading organizations.");
    } finally {
      setOrgsLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setState({ kind: "loading" });
    try {
      const res = await apiFetch("/api/admin/organizations/create", {
        method: "POST",
        body: JSON.stringify({
          organizationName: orgName.trim(),
          ownerEmail: ownerEmail.trim(),
          ownerName: ownerName.trim() || undefined
        })
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setState({
          kind: "error",
          message: getResponseMessage(body, "Something went wrong. Please try again.")
        });
        return;
      }
      setState({ kind: "success", email: ownerEmail.trim(), orgName: orgName.trim() });
      setOrgName("");
      setOwnerEmail("");
      setOwnerName("");
      void loadOrganizations();
    } catch {
      setState({ kind: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "1.5rem 1rem 2rem" }}>

      {/* ── Create Organization ─────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Create Organization</h2>
        <p style={descriptionStyle}>
          Creates a new greenhouse organization and sends an invite email to the owner.
        </p>

        {state.kind === "success" ? (
          <div style={successCardStyle}>
            <p style={{ margin: 0, fontWeight: 600, color: "var(--brand)" }}>
              Invite sent to {state.email}
            </p>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem", color: "var(--text-muted)" }}>
              Organization &ldquo;{state.orgName}&rdquo; was created. The owner will receive an
              email to set their password and log in.
            </p>
            <button
              type="button"
              onClick={() => setState({ kind: "idle" })}
              style={secondaryButtonStyle}
            >
              Create another
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={cardStyle}>
            <div style={{ marginBottom: "0.85rem" }}>
              <label htmlFor="org-name" style={labelStyle}>
                Organization name <span style={{ color: "#c0392b" }}>*</span>
              </label>
              <input
                id="org-name"
                type="text"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. Sunrise Greenhouse"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: "0.85rem" }}>
              <label htmlFor="owner-email" style={labelStyle}>
                Owner email <span style={{ color: "#c0392b" }}>*</span>
              </label>
              <input
                id="owner-email"
                type="email"
                required
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="owner@example.com"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <label htmlFor="owner-name" style={labelStyle}>
                Owner name{" "}
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="owner-name"
                type="text"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="e.g. Jan de Boer"
                style={inputStyle}
              />
            </div>

            {state.kind === "error" && <p style={errorBannerStyle}>{state.message}</p>}

            <button
              type="submit"
              disabled={state.kind === "loading"}
              style={primaryButtonStyle}
            >
              {state.kind === "loading" ? "Creating..." : "Create organization and send invite"}
            </button>
          </form>
        )}
      </section>

      {/* ── Organizations List ──────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.2rem"
          }}
        >
          <h2 style={{ ...titleStyle, marginBottom: 0 }}>Organizations</h2>
          <button
            type="button"
            onClick={() => void loadOrganizations()}
            disabled={orgsLoading}
            style={secondaryButtonStyle}
          >
            Refresh
          </button>
        </div>
        <p style={descriptionStyle}>All registered greenhouse organizations.</p>

        {orgsError && <p style={errorBannerStyle}>{orgsError}</p>}

        <div style={cardStyle}>
          {orgsLoading ? (
            <p style={mutedTextStyle}>Loading organizations...</p>
          ) : organizations.length === 0 ? (
            <p style={mutedTextStyle}>No organizations yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={tableHeaderStyle}>Name</th>
                    <th style={tableHeaderStyle}>ID</th>
                    <th style={tableHeaderStyle}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {organizations.map((org) => (
                    <tr key={org.id}>
                      <td style={{ ...tableCellStyle, fontWeight: 500 }}>{org.name}</td>
                      <td
                        style={{
                          ...tableCellStyle,
                          fontFamily: "ui-monospace, Consolas, monospace",
                          fontSize: "0.75rem",
                          color: "var(--text-muted)"
                        }}
                      >
                        {org.id}
                      </td>
                      <td style={tableCellStyle}>{formatDate(org.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const sectionStyle: CSSProperties = { marginBottom: "1rem" };

const titleStyle: CSSProperties = {
  fontSize: "1.15rem",
  fontWeight: 600,
  marginBottom: "0.2rem",
  color: "var(--text)"
};

const descriptionStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "0.85rem",
  marginBottom: "0.8rem",
  marginTop: 0
};

const mutedTextStyle: CSSProperties = {
  margin: "0.25rem 0",
  color: "var(--text-muted)",
  fontSize: "0.875rem"
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "0.9rem"
};

const successCardStyle: CSSProperties = {
  background: "var(--brand-soft)",
  border: "1px solid var(--brand)",
  borderRadius: 8,
  padding: "0.8rem",
  marginBottom: "0.75rem"
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  fontWeight: 500,
  marginBottom: "0.3rem"
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.65rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.9rem",
  color: "var(--text)",
  background: "var(--surface-soft)",
  outline: "none"
};

const primaryButtonStyle: CSSProperties = {
  width: "100%",
  padding: "0.6rem 0.75rem",
  background: "var(--brand)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.88rem",
  fontWeight: 600
};

const secondaryButtonStyle: CSSProperties = {
  marginTop: "0.5rem",
  padding: "0.42rem 0.65rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.8rem",
  fontWeight: 500
};

const errorBannerStyle: CSSProperties = {
  margin: "0 0 0.5rem",
  padding: "0.55rem 0.7rem",
  background: "#fdf2f2",
  border: "1px solid #f5c6c6",
  borderRadius: 6,
  fontSize: "0.82rem",
  color: "#c0392b"
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.83rem"
};

const tableHeaderStyle: CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-muted)",
  fontWeight: 600,
  padding: "0.45rem"
};

const tableCellStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  padding: "0.45rem",
  verticalAlign: "middle"
};
