import { FormEvent, useEffect, useState, type CSSProperties } from "react";
import { apiFetch } from "../lib/api";

type SubmitState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; email: string; orgName: string }
  | { kind: "error"; message: string };

type KeyCreateState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "success" };

type OrganizationOption = {
  id: string;
  name: string;
};

type UploadKeyRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  label: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

type FlowMasterImportRunRow = {
  id: string;
  lotNumber: string;
  sourceFilename: string | null;
  varietyId: string | null;
  varietyName: string | null;
  isoYear: number | null;
  isoWeek: number | null;
  startTime: string | null;
  importedAt: string;
};

type CreatedKeyState = {
  key: string;
  label: string;
  organizationName: string;
};

function getResponseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const maybeMessage = (body as { message?: unknown }).message;
  return typeof maybeMessage === "string" && maybeMessage.trim().length > 0
    ? maybeMessage
    : fallback;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

export function AdminOrganizationsPage() {
  const [orgName, setOrgName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [keyRows, setKeyRows] = useState<UploadKeyRow[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keyCreateState, setKeyCreateState] = useState<KeyCreateState>({ kind: "idle" });
  const [createdKey, setCreatedKey] = useState<CreatedKeyState | null>(null);
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [importRuns, setImportRuns] = useState<FlowMasterImportRunRow[]>([]);
  const [importRunsLoading, setImportRunsLoading] = useState(true);
  const [importRunsError, setImportRunsError] = useState<string | null>(null);
  const [selectedImportRunIds, setSelectedImportRunIds] = useState<Set<string>>(new Set());
  const [deleteImportRunsBusy, setDeleteImportRunsBusy] = useState(false);

  useEffect(() => {
    void loadOrganizations();
    void loadKeys();
    void loadImportRuns();
  }, []);

  async function loadOrganizations() {
    try {
      const res = await apiFetch("/api/admin/organizations");
      const body = (await res.json().catch(() => ({}))) as {
        organizations?: OrganizationOption[];
      };

      if (!res.ok) {
        setManagementError("Failed to load organizations.");
        return;
      }

      const safeOrganizations = Array.isArray(body.organizations) ? body.organizations : [];
      setOrganizations(safeOrganizations);
      setSelectedOrganizationId(prev =>
        prev || safeOrganizations.length === 0 ? prev : safeOrganizations[0].id
      );
      setManagementError(null);
    } catch {
      setManagementError("Network error while loading organizations.");
    }
  }

  async function loadKeys() {
    setKeysLoading(true);
    try {
      const res = await apiFetch("/api/admin/upload-keys");
      const body = (await res.json().catch(() => ({}))) as {
        keys?: UploadKeyRow[];
      };

      if (!res.ok) {
        setManagementError("Failed to load upload keys.");
        setKeysLoading(false);
        return;
      }

      setKeyRows(Array.isArray(body.keys) ? body.keys : []);
      setManagementError(null);
    } catch {
      setManagementError("Network error while loading upload keys.");
    } finally {
      setKeysLoading(false);
    }
  }

  async function loadImportRuns() {
    setImportRunsLoading(true);
    try {
      const res = await apiFetch("/api/admin/flowmaster/import-runs");
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        runs?: FlowMasterImportRunRow[];
      };

      if (!res.ok) {
        setImportRunsError(getResponseMessage(body, "Failed to load FlowMaster import runs."));
        setImportRunsLoading(false);
        return;
      }

      const safeRuns = Array.isArray(body.runs) ? body.runs : [];
      setImportRuns(safeRuns);
      setSelectedImportRunIds((prev) => {
        const next = new Set<string>();
        const validIds = new Set(safeRuns.map((run) => run.id));
        for (const id of prev) {
          if (validIds.has(id)) next.add(id);
        }
        return next;
      });
      setImportRunsError(null);
    } catch {
      setImportRunsError("Network error while loading FlowMaster import runs.");
    } finally {
      setImportRunsLoading(false);
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

  async function handleCreateUploadKey(e: FormEvent) {
    e.preventDefault();

    if (!selectedOrganizationId) {
      setKeyCreateState({ kind: "error", message: "Select an organization first." });
      return;
    }

    if (!keyLabel.trim()) {
      setKeyCreateState({ kind: "error", message: "A key label is required." });
      return;
    }

    setKeyCreateState({ kind: "loading" });

    try {
      const res = await apiFetch("/api/admin/upload-keys", {
        method: "POST",
        body: JSON.stringify({
          organizationId: selectedOrganizationId,
          label: keyLabel.trim()
        })
      });

      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        key?: string;
      };

      if (!res.ok) {
        setKeyCreateState({
          kind: "error",
          message: getResponseMessage(body, "Failed to create upload key.")
        });
        return;
      }

      const selectedOrganization = organizations.find(org => org.id === selectedOrganizationId);
      setCreatedKey({
        key: typeof body.key === "string" ? body.key : "",
        label: keyLabel.trim(),
        organizationName: selectedOrganization?.name ?? "Unknown"
      });
      setKeyCreateState({ kind: "success" });
      setKeyLabel("");
      await loadKeys();
    } catch {
      setKeyCreateState({ kind: "error", message: "Network error while creating upload key." });
    }
  }

  async function handleCopyRawKey() {
    if (!createdKey?.key) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
    } catch {
      setKeyCreateState({ kind: "error", message: "Failed to copy key to clipboard." });
    }
  }

  async function handleRevokeKey(keyId: string) {
    setRevokeBusyId(keyId);
    setManagementError(null);

    try {
      const res = await apiFetch(`/api/admin/upload-keys/${keyId}/revoke`, {
        method: "POST"
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setManagementError(getResponseMessage(body, "Failed to revoke upload key."));
        setRevokeBusyId(null);
        return;
      }

      await loadKeys();
    } catch {
      setManagementError("Network error while revoking upload key.");
    } finally {
      setRevokeBusyId(null);
    }
  }

  function toggleImportRunSelection(id: string) {
    setSelectedImportRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAllImportRuns() {
    setSelectedImportRunIds((prev) => {
      if (prev.size === importRuns.length) {
        return new Set();
      }
      return new Set(importRuns.map((run) => run.id));
    });
  }

  async function handleDeleteSelectedImportRuns() {
    if (selectedImportRunIds.size === 0 || deleteImportRunsBusy) {
      return;
    }

    const confirmed = window.confirm(
      "This only deletes import history. It does not delete yield data. This lot may import again if FlowMaster sends it."
    );

    if (!confirmed) {
      return;
    }

    setDeleteImportRunsBusy(true);
    setImportRunsError(null);

    try {
      const ids = Array.from(selectedImportRunIds);
      const res = await apiFetch("/api/admin/flowmaster/import-runs/delete", {
        method: "POST",
        body: JSON.stringify({ ids })
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };

      if (!res.ok) {
        setImportRunsError(getResponseMessage(body, "Failed to delete selected import runs."));
        setDeleteImportRunsBusy(false);
        return;
      }

      setSelectedImportRunIds(new Set());
      await loadImportRuns();
    } catch {
      setImportRunsError("Network error while deleting import runs.");
    } finally {
      setDeleteImportRunsBusy(false);
    }
  }

  function handleReset() {
    setState({ kind: "idle" });
  }

  const allImportRunsSelected =
    importRuns.length > 0 && selectedImportRunIds.size === importRuns.length;

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "1.5rem 1rem 2rem" }}>
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
            <button type="button" onClick={handleReset} style={secondaryButtonStyle}>
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
                onChange={e => setOrgName(e.target.value)}
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
                onChange={e => setOwnerEmail(e.target.value)}
                placeholder="owner@example.com"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <label htmlFor="owner-name" style={labelStyle}>
                Owner name <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span>
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

            {state.kind === "error" && <p style={errorBannerStyle}>{state.message}</p>}

            <button type="submit" disabled={state.kind === "loading"} style={primaryButtonStyle}>
              {state.kind === "loading" ? "Creating..." : "Create organization and send invite"}
            </button>
          </form>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={titleStyle}>FlowMaster Upload Keys</h2>
        <p style={descriptionStyle}>
          Create and revoke upload keys used by FlowMaster agents. Raw keys are shown once at creation.
        </p>

        <form onSubmit={handleCreateUploadKey} style={cardStyle}>
          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "1fr 1fr auto" }}>
            <div>
              <label htmlFor="key-org" style={labelStyle}>
                Organization <span style={{ color: "#c0392b" }}>*</span>
              </label>
              <select
                id="key-org"
                required
                value={selectedOrganizationId}
                onChange={e => setSelectedOrganizationId(e.target.value)}
                style={inputStyle}
              >
                {organizations.length === 0 ? (
                  <option value="">No organizations available</option>
                ) : (
                  organizations.map(org => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label htmlFor="key-label" style={labelStyle}>
                Label <span style={{ color: "#c0392b" }}>*</span>
              </label>
              <input
                id="key-label"
                type="text"
                required
                value={keyLabel}
                onChange={e => setKeyLabel(e.target.value)}
                placeholder="e.g. Packline 1"
                style={inputStyle}
              />
            </div>

            <div style={{ alignSelf: "end" }}>
              <button
                type="submit"
                disabled={keyCreateState.kind === "loading" || organizations.length === 0}
                style={primaryButtonStyle}
              >
                {keyCreateState.kind === "loading" ? "Creating..." : "Create key"}
              </button>
            </div>
          </div>

          {keyCreateState.kind === "error" && <p style={{ ...errorBannerStyle, marginTop: "0.75rem" }}>{keyCreateState.message}</p>}
        </form>

        {createdKey && (
          <div style={successCardStyle}>
            <p style={{ margin: 0, fontWeight: 600, color: "var(--brand)" }}>
              Upload key created: {createdKey.label} ({createdKey.organizationName})
            </p>
            <p style={{ margin: "0.5rem 0", fontSize: "0.875rem", color: "var(--text-muted)" }}>
              Save this key now. For safety, it cannot be viewed again.
            </p>
            <div
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: "0.82rem",
                background: "var(--surface-soft)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "0.65rem 0.75rem",
                marginBottom: "0.6rem",
                overflowX: "auto"
              }}
            >
              {createdKey.key || "(key unavailable)"}
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button type="button" onClick={handleCopyRawKey} style={secondaryButtonStyle}>
                Copy key
              </button>
              <button type="button" onClick={() => setCreatedKey(null)} style={secondaryButtonStyle}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {managementError && <p style={errorBannerStyle}>{managementError}</p>}

        <div style={cardStyle}>
          <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem", color: "var(--text)" }}>Existing Keys</h3>
          {keysLoading ? (
            <p style={{ margin: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>Loading keys...</p>
          ) : keyRows.length === 0 ? (
            <p style={{ margin: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>
              No upload keys created yet.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={tableHeaderStyle}>Label</th>
                    <th style={tableHeaderStyle}>Organization</th>
                    <th style={tableHeaderStyle}>Status</th>
                    <th style={tableHeaderStyle}>Created</th>
                    <th style={tableHeaderStyle}>Last Used</th>
                    <th style={tableHeaderStyle}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {keyRows.map(row => (
                    <tr key={row.id}>
                      <td style={tableCellStyle}>{row.label}</td>
                      <td style={tableCellStyle}>{row.organizationName}</td>
                      <td style={tableCellStyle}>
                        <span style={row.status === "active" ? activeBadgeStyle : revokedBadgeStyle}>
                          {row.status}
                        </span>
                      </td>
                      <td style={tableCellStyle}>{formatDateTime(row.createdAt)}</td>
                      <td style={tableCellStyle}>{formatDateTime(row.lastUsedAt)}</td>
                      <td style={tableCellStyle}>
                        <button
                          type="button"
                          onClick={() => handleRevokeKey(row.id)}
                          disabled={row.status === "revoked" || revokeBusyId === row.id}
                          style={smallDangerButtonStyle}
                        >
                          {row.status === "revoked"
                            ? "Revoked"
                            : revokeBusyId === row.id
                              ? "Revoking..."
                              : "Revoke"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={titleStyle}>FlowMaster Import Runs</h2>
        <p style={descriptionStyle}>
          Manage lot-level import history for this organization. Deleting import runs allows FlowMaster to re-import matching lots.
        </p>
        <p style={warningTextStyle}>
          Deleting import history does not delete already-imported KG yield data.
        </p>

        {importRunsError && <p style={errorBannerStyle}>{importRunsError}</p>}

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", marginBottom: "0.6rem", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: "1rem", color: "var(--text)" }}>Import History</h3>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                type="button"
                onClick={() => void loadImportRuns()}
                disabled={importRunsLoading || deleteImportRunsBusy}
                style={secondaryButtonStyle}
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteSelectedImportRuns()}
                disabled={selectedImportRunIds.size === 0 || deleteImportRunsBusy}
                style={smallDangerButtonStyle}
              >
                {deleteImportRunsBusy
                  ? "Deleting..."
                  : `Delete selected (${selectedImportRunIds.size})`}
              </button>
            </div>
          </div>

          {importRunsLoading ? (
            <p style={{ margin: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>Loading import runs...</p>
          ) : importRuns.length === 0 ? (
            <p style={{ margin: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>
              No import runs found for this organization.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={tableHeaderStyle}>
                      <input
                        type="checkbox"
                        aria-label="Select all import runs"
                        checked={allImportRunsSelected}
                        onChange={toggleSelectAllImportRuns}
                      />
                    </th>
                    <th style={tableHeaderStyle}>Lot Number</th>
                    <th style={tableHeaderStyle}>Source Filename</th>
                    <th style={tableHeaderStyle}>Variety</th>
                    <th style={tableHeaderStyle}>ISO Year/Week</th>
                    <th style={tableHeaderStyle}>Start Time</th>
                    <th style={tableHeaderStyle}>Imported At</th>
                  </tr>
                </thead>
                <tbody>
                  {importRuns.map((run) => (
                    <tr key={run.id}>
                      <td style={tableCellStyle}>
                        <input
                          type="checkbox"
                          aria-label={`Select lot ${run.lotNumber}`}
                          checked={selectedImportRunIds.has(run.id)}
                          onChange={() => toggleImportRunSelection(run.id)}
                        />
                      </td>
                      <td style={tableCellStyle}>{run.lotNumber}</td>
                      <td style={tableCellStyle}>{run.sourceFilename ?? "-"}</td>
                      <td style={tableCellStyle}>{run.varietyName ?? "-"}</td>
                      <td style={tableCellStyle}>
                        {run.isoYear !== null && run.isoWeek !== null
                          ? `${run.isoYear}-W${String(run.isoWeek).padStart(2, "0")}`
                          : "-"}
                      </td>
                      <td style={tableCellStyle}>{formatDateTime(run.startTime)}</td>
                      <td style={tableCellStyle}>{formatDateTime(run.importedAt)}</td>
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

const sectionStyle: CSSProperties = {
  marginBottom: "1rem"
};

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

const warningTextStyle: CSSProperties = {
  marginTop: "-0.35rem",
  marginBottom: "0.8rem",
  padding: "0.55rem 0.7rem",
  background: "#fff7e6",
  border: "1px solid #f2d39b",
  borderRadius: 6,
  fontSize: "0.82rem",
  color: "#7f5a00"
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

const smallDangerButtonStyle: CSSProperties = {
  padding: "0.3rem 0.55rem",
  background: "#c0392b",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.78rem",
  fontWeight: 600
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

const activeBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "#e8f8ef",
  color: "#1f7a42",
  border: "1px solid #bfe9cf"
};

const revokedBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "#f9eaea",
  color: "#8f2d1f",
  border: "1px solid #f0c5be"
};
