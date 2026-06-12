import { FormEvent, useEffect, useMemo, useState, type CSSProperties } from "react";
import { apiFetch } from "../lib/api";

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

type ImportRunRow = {
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

type KeyCreateState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "success" };

function getResponseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const maybeMessage = (body as { message?: unknown }).message;
  return typeof maybeMessage === "string" && maybeMessage.trim().length > 0
    ? maybeMessage
    : fallback;
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

const DATA_SOURCES = [
  {
    id: "flowmaster",
    name: "FlowMaster Import",
    description: "Automated lot-level yield data from FlowMaster packline software",
    status: "enabled" as const
  },
  {
    id: "packline-kg",
    name: "Packline KG Import",
    description: "Raw kg entries from packline systems via upload key",
    status: "enabled" as const
  }
];

export function AdminGrowlinkAgentPage() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [keyRows, setKeyRows] = useState<UploadKeyRow[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keyCreateState, setKeyCreateState] = useState<KeyCreateState>({ kind: "idle" });
  const [createdKey, setCreatedKey] = useState<CreatedKeyState | null>(null);
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [importRuns, setImportRuns] = useState<ImportRunRow[]>([]);
  const [importRunsLoading, setImportRunsLoading] = useState(true);
  const [importRunsError, setImportRunsError] = useState<string | null>(null);
  const [selectedImportRunIds, setSelectedImportRunIds] = useState<Set<string>>(new Set());
  const [deleteImportRunsBusy, setDeleteImportRunsBusy] = useState(false);

  const agentHealth = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const activeKeys = keyRows.filter((k) => k.status === "active").length;
    const importsToday = importRuns.filter((r) => r.importedAt.slice(0, 10) === today).length;
    const lastImport =
      importRuns.length > 0
        ? importRuns.reduce((max, r) => (r.importedAt > max ? r.importedAt : max), "")
        : null;
    return {
      totalKeys: keyRows.length,
      activeKeys,
      totalImports: importRuns.length,
      importsToday,
      lastImport
    };
  }, [keyRows, importRuns]);

  const allImportRunsSelected =
    importRuns.length > 0 && selectedImportRunIds.size === importRuns.length;

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
      if (!res.ok) return;
      const safeOrgs = Array.isArray(body.organizations) ? body.organizations : [];
      setOrganizations(safeOrgs);
      setSelectedOrganizationId((prev) =>
        prev || safeOrgs.length === 0 ? prev : safeOrgs[0].id
      );
    } catch {
      // non-fatal — org dropdown just stays empty
    }
  }

  async function loadKeys() {
    setKeysLoading(true);
    try {
      const res = await apiFetch("/api/admin/upload-keys");
      const body = (await res.json().catch(() => ({}))) as { keys?: UploadKeyRow[] };
      if (!res.ok) {
        setManagementError("Failed to load upload keys.");
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
        runs?: ImportRunRow[];
      };
      if (!res.ok) {
        setImportRunsError(getResponseMessage(body, "Failed to load import runs."));
        return;
      }
      const safeRuns = Array.isArray(body.runs) ? body.runs : [];
      setImportRuns(safeRuns);
      setSelectedImportRunIds((prev) => {
        const next = new Set<string>();
        const validIds = new Set(safeRuns.map((r) => r.id));
        for (const id of prev) {
          if (validIds.has(id)) next.add(id);
        }
        return next;
      });
      setImportRunsError(null);
    } catch {
      setImportRunsError("Network error while loading import runs.");
    } finally {
      setImportRunsLoading(false);
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
        body: JSON.stringify({ organizationId: selectedOrganizationId, label: keyLabel.trim() })
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; key?: string };
      if (!res.ok) {
        setKeyCreateState({
          kind: "error",
          message: getResponseMessage(body, "Failed to create upload key.")
        });
        return;
      }
      const selectedOrg = organizations.find((o) => o.id === selectedOrganizationId);
      setCreatedKey({
        key: typeof body.key === "string" ? body.key : "",
        label: keyLabel.trim(),
        organizationName: selectedOrg?.name ?? "Unknown"
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
      const res = await apiFetch(`/api/admin/upload-keys/${keyId}/revoke`, { method: "POST" });
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllImportRuns() {
    setSelectedImportRunIds((prev) =>
      prev.size === importRuns.length ? new Set() : new Set(importRuns.map((r) => r.id))
    );
  }

  async function handleDeleteSelectedImportRuns() {
    if (selectedImportRunIds.size === 0 || deleteImportRunsBusy) return;
    const confirmed = window.confirm(
      "This only deletes import history. It does not delete yield data. This lot may import again if the agent sends it."
    );
    if (!confirmed) return;
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

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "1.5rem 1rem 2rem" }}>

      {/* ── Section 1: Agent Connections ─────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Agent Connections</h2>
        <p style={descriptionStyle}>
          Active and revoked agent connections for all organizations.
        </p>
        <div style={cardStyle}>
          {keysLoading ? (
            <p style={mutedTextStyle}>Loading connections...</p>
          ) : keyRows.length === 0 ? (
            <p style={mutedTextStyle}>No agent connections yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={tableHeaderStyle}>Agent Name</th>
                    <th style={tableHeaderStyle}>Organization</th>
                    <th style={tableHeaderStyle}>Status</th>
                    <th style={tableHeaderStyle}>Created</th>
                    <th style={tableHeaderStyle}>Last Seen</th>
                    <th style={tableHeaderStyle}>Last Used</th>
                    <th style={tableHeaderStyle}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keyRows.map((row) => (
                    <tr key={row.id}>
                      <td style={tableCellStyle}>{row.label}</td>
                      <td style={tableCellStyle}>{row.organizationName}</td>
                      <td style={tableCellStyle}>
                        <span
                          style={row.status === "active" ? connectedBadgeStyle : disconnectedBadgeStyle}
                        >
                          {row.status === "active" ? "Connected" : "Disconnected"}
                        </span>
                      </td>
                      <td style={tableCellStyle}>{formatDateTime(row.createdAt)}</td>
                      <td style={tableCellStyle}>—</td>
                      <td style={tableCellStyle}>{formatDateTime(row.lastUsedAt)}</td>
                      <td style={tableCellStyle}>
                        {row.status === "active" ? (
                          <button
                            type="button"
                            onClick={() => void handleRevokeKey(row.id)}
                            disabled={revokeBusyId === row.id}
                            style={smallDangerButtonStyle}
                          >
                            {revokeBusyId === row.id ? "Revoking..." : "Revoke"}
                          </button>
                        ) : (
                          <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ── Section 2: Agent Upload Keys ─────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Agent Upload Keys</h2>
        <p style={descriptionStyle}>
          Create and revoke upload keys used by GrowLink Agent instances. Raw keys are shown once at creation.
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
                onChange={(e) => setSelectedOrganizationId(e.target.value)}
                style={inputStyle}
              >
                {organizations.length === 0 ? (
                  <option value="">No organizations available</option>
                ) : (
                  organizations.map((org) => (
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
                onChange={(e) => setKeyLabel(e.target.value)}
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
          {keyCreateState.kind === "error" && (
            <p style={{ ...errorBannerStyle, marginTop: "0.75rem" }}>{keyCreateState.message}</p>
          )}
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
          <h3 style={subheadingStyle}>Existing Keys</h3>
          {keysLoading ? (
            <p style={mutedTextStyle}>Loading keys...</p>
          ) : keyRows.length === 0 ? (
            <p style={mutedTextStyle}>No upload keys created yet.</p>
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
                  {keyRows.map((row) => (
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
                          onClick={() => void handleRevokeKey(row.id)}
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

      {/* ── Section 3: Data Sources ───────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Data Sources</h2>
        <p style={descriptionStyle}>
          Capabilities supported by this agent installation.
        </p>
        <div style={cardStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={tableHeaderStyle}>Source</th>
                <th style={tableHeaderStyle}>Description</th>
                <th style={tableHeaderStyle}>Status</th>
              </tr>
            </thead>
            <tbody>
              {DATA_SOURCES.map((source) => (
                <tr key={source.id}>
                  <td style={{ ...tableCellStyle, fontWeight: 500 }}>{source.name}</td>
                  <td style={{ ...tableCellStyle, color: "var(--text-muted)" }}>
                    {source.description}
                  </td>
                  <td style={tableCellStyle}>
                    <span style={activeBadgeStyle}>Enabled</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Section 4: Import History ─────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Import History</h2>
        <p style={descriptionStyle}>
          Lot-level import history. Deleting an entry allows the agent to re-import that lot.
        </p>
        <p style={warningTextStyle}>
          Deleting import history does not delete already-imported yield data.
        </p>

        {importRunsError && <p style={errorBannerStyle}>{importRunsError}</p>}

        <div style={cardStyle}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "0.75rem",
              alignItems: "center",
              marginBottom: "0.6rem",
              flexWrap: "wrap"
            }}
          >
            <h3 style={subheadingStyle}>Imports</h3>
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
            <p style={mutedTextStyle}>Loading import history...</p>
          ) : importRuns.length === 0 ? (
            <p style={mutedTextStyle}>No imports found.</p>
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
                    <th style={tableHeaderStyle}>Source File</th>
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
                      <td style={tableCellStyle}>{run.sourceFilename ?? "—"}</td>
                      <td style={tableCellStyle}>{run.varietyName ?? "—"}</td>
                      <td style={tableCellStyle}>
                        {run.isoYear !== null && run.isoWeek !== null
                          ? `${run.isoYear}-W${String(run.isoWeek).padStart(2, "0")}`
                          : "—"}
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

      {/* ── Section 5: Agent Health ───────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Agent Health</h2>
        <p style={descriptionStyle}>
          Summary of agent activity across all organizations.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: "0.75rem"
          }}
        >
          <StatCard label="Total Keys" value={String(agentHealth.totalKeys)} />
          <StatCard label="Active Keys" value={String(agentHealth.activeKeys)} />
          <StatCard label="Total Imports" value={String(agentHealth.totalImports)} />
          <StatCard label="Imports Today" value={String(agentHealth.importsToday)} />
          <StatCard
            label="Last Import"
            value={agentHealth.lastImport ? formatDateTime(agentHealth.lastImport) : "—"}
          />
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "0.85rem 0.9rem"
      }}
    >
      <p
        style={{
          margin: "0 0 0.2rem",
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          fontWeight: 500
        }}
      >
        {label}
      </p>
      <p
        style={{
          margin: 0,
          fontSize: "1.15rem",
          fontWeight: 600,
          color: "var(--text)"
        }}
      >
        {value}
      </p>
    </div>
  );
}

// ── Style constants ───────────────────────────────────────────────────────────

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

const subheadingStyle: CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  color: "var(--text)"
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

const connectedBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "#e8f8ef",
  color: "#1f7a42",
  border: "1px solid #bfe9cf"
};

const disconnectedBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "#f9eaea",
  color: "#8f2d1f",
  border: "1px solid #f0c5be"
};
