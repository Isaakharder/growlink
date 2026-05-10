import { FormEvent, useState } from "react";
import { apiFetch } from "../lib/api";

type SubmitState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; email: string; orgName: string }
  | { kind: "error"; message: string };

export function AdminOrganizationsPage() {
  const [orgName, setOrgName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

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

      const body = (await res.json()) as { message?: string };

      if (!res.ok) {
        setState({
          kind: "error",
          message: body.message ?? "Something went wrong. Please try again."
        });
        return;
      }

      setState({ kind: "success", email: ownerEmail.trim(), orgName: orgName.trim() });
      setOrgName("");
      setOwnerEmail("");
      setOwnerName("");
    } catch {
      setState({ kind: "error", message: "Network error. Please try again." });
    }
  }

  function handleReset() {
    setState({ kind: "idle" });
  }

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "2rem 1rem" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--text)" }}>
        Create Organization
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "2rem", marginTop: 0 }}>
        Creates a new greenhouse organization and sends an invite email to the owner.
      </p>

      {state.kind === "success" ? (
        <div
          style={{
            background: "var(--brand-soft)",
            border: "1px solid var(--brand)",
            borderRadius: 8,
            padding: "1.25rem 1.5rem",
            marginBottom: "1.5rem"
          }}
        >
          <p style={{ margin: 0, fontWeight: 600, color: "var(--brand)" }}>
            Invite sent to {state.email}
          </p>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem", color: "var(--text-muted)" }}>
            Organization &ldquo;{state.orgName}&rdquo; was created. The owner will receive an
            email to set their password and log in.
          </p>
          <button
            type="button"
            onClick={handleReset}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              background: "var(--brand)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: "0.875rem",
              fontWeight: 500
            }}
          >
            Create another
          </button>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "1.5rem"
          }}
        >
          <div style={{ marginBottom: "1.25rem" }}>
            <label
              htmlFor="org-name"
              style={{ display: "block", fontSize: "0.875rem", fontWeight: 500, marginBottom: "0.375rem" }}
            >
              Organization name <span style={{ color: "#c0392b" }}>*</span>
            </label>
            <input
              id="org-name"
              type="text"
              required
              value={orgName}
              onChange={e => setOrgName(e.target.value)}
              placeholder="e.g. Sunrise Greenhouse"
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label
              htmlFor="owner-email"
              style={{ display: "block", fontSize: "0.875rem", fontWeight: 500, marginBottom: "0.375rem" }}
            >
              Owner email <span style={{ color: "#c0392b" }}>*</span>
            </label>
            <input
              id="owner-email"
              type="email"
              required
              value={ownerEmail}
              onChange={e => setOwnerEmail(e.target.value)}
              placeholder="owner@example.com"
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: "1.75rem" }}>
            <label
              htmlFor="owner-name"
              style={{ display: "block", fontSize: "0.875rem", fontWeight: 500, marginBottom: "0.375rem" }}
            >
              Owner name{" "}
              <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              id="owner-name"
              type="text"
              value={ownerName}
              onChange={e => setOwnerName(e.target.value)}
              placeholder="e.g. Jan de Boer"
              style={inputStyle}
            />
          </div>

          {state.kind === "error" && (
            <p
              style={{
                margin: "0 0 1rem",
                padding: "0.75rem 1rem",
                background: "#fdf2f2",
                border: "1px solid #f5c6c6",
                borderRadius: 6,
                fontSize: "0.875rem",
                color: "#c0392b"
              }}
            >
              {state.message}
            </p>
          )}

          <button
            type="submit"
            disabled={state.kind === "loading"}
            style={{
              width: "100%",
              padding: "0.65rem",
              background: state.kind === "loading" ? "var(--text-muted)" : "var(--brand)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: state.kind === "loading" ? "not-allowed" : "pointer",
              fontSize: "0.9375rem",
              fontWeight: 600
            }}
          >
            {state.kind === "loading" ? "Creating…" : "Create organization & send invite"}
          </button>
        </form>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.9375rem",
  color: "var(--text)",
  background: "var(--surface-soft)",
  outline: "none"
};
