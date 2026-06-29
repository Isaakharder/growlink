import { FormEvent, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
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
  dataSourceType: string;
  hasTemplate: boolean;
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

type ClimateImportSummary = {
  totalImports: number;
  lastImportAt: string | null;
  readingsToday: number;
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
  },
  {
    id: "climate-agent",
    name: "Climate Agent",
    description: "Weather station + block summary CSV exports from the Windows Climate Agent",
    status: "enabled" as const
  }
];

export function AdminGrowlinkAgentPage() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [keyDataSourceType, setKeyDataSourceType] = useState("flowmaster");
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
  const [deleteResult, setDeleteResult] = useState<string | null>(null);
  const [filterYear, setFilterYear] = useState("");
  const [filterWeek, setFilterWeek] = useState("");
  const [filterFilename, setFilterFilename] = useState("");
  const [importDeleteConfirm, setImportDeleteConfirm] = useState<{ title: string; ids: string[] } | null>(null);
  const [climateSummary, setClimateSummary] = useState<ClimateImportSummary | null>(null);
  const [climateSummaryLoading, setClimateSummaryLoading] = useState(true);
  const [climateSummaryError, setClimateSummaryError] = useState<string | null>(null);
  const [hideRevoked, setHideRevoked] = useState(true);
  const [selectedKeyIds, setSelectedKeyIds] = useState<Set<string>>(new Set());
  const [keyDeleteConfirm, setKeyDeleteConfirm] = useState<{ ids: string[] } | null>(null);
  const [keyDeleteBusy, setKeyDeleteBusy] = useState(false);
  const [keyDeleteResult, setKeyDeleteResult] = useState<string | null>(null);

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

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    for (const run of importRuns) {
      if (run.isoYear !== null) years.add(run.isoYear);
    }
    return Array.from(years).sort((a, b) => b - a);
  }, [importRuns]);

  const availableWeeks = useMemo(() => {
    const selectedYear = Number(filterYear);
    if (!Number.isInteger(selectedYear) || !filterYear) return [];
    const weeks = new Set<number>();
    for (const run of importRuns) {
      if (run.isoYear === selectedYear && run.isoWeek !== null) weeks.add(run.isoWeek);
    }
    return Array.from(weeks).sort((a, b) => a - b);
  }, [importRuns, filterYear]);

  const filteredImportRuns = useMemo(() => {
    return importRuns.filter((run) => {
      if (filterYear && run.isoYear !== Number(filterYear)) return false;
      if (filterWeek && run.isoWeek !== Number(filterWeek)) return false;
      if (filterFilename.trim()) {
        const q = filterFilename.trim().toLowerCase();
        if (!run.sourceFilename?.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [importRuns, filterYear, filterWeek, filterFilename]);

  const allFilteredSelected =
    filteredImportRuns.length > 0 &&
    filteredImportRuns.every((r) => selectedImportRunIds.has(r.id));

  const allImportRunsSelected =
    importRuns.length > 0 && selectedImportRunIds.size === importRuns.length;

  const displayedKeyRows = useMemo(
    () => (hideRevoked ? keyRows.filter((k) => k.status === "active") : keyRows),
    [keyRows, hideRevoked]
  );
  const revokedKeyCount = keyRows.length - agentHealth.activeKeys;
  const visibleRevokedRows = displayedKeyRows.filter((k) => k.status === "revoked");
  const selectedRevokedIds = Array.from(selectedKeyIds).filter((id) =>
    keyRows.some((k) => k.id === id && k.status === "revoked")
  );
  const allVisibleRevokedSelected =
    visibleRevokedRows.length > 0 && visibleRevokedRows.every((k) => selectedKeyIds.has(k.id));

  useEffect(() => {
    void loadOrganizations();
    void loadKeys();
    void loadImportRuns();
    void loadClimateSummary();
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
      const newKeys = Array.isArray(body.keys) ? body.keys : [];
      setKeyRows(newKeys);
      setSelectedKeyIds((prev) => {
        const validIds = new Set(newKeys.map((k) => k.id));
        const next = new Set<string>();
        for (const id of prev) {
          if (validIds.has(id)) next.add(id);
        }
        return next;
      });
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

  async function loadClimateSummary() {
    setClimateSummaryLoading(true);
    try {
      const res = await apiFetch("/api/admin/climate-imports/summary");
      const body = (await res.json().catch(() => ({}))) as Partial<ClimateImportSummary> & {
        message?: string;
      };
      if (!res.ok) {
        setClimateSummaryError(getResponseMessage(body, "Failed to load climate import status."));
        return;
      }
      setClimateSummary({
        totalImports: body.totalImports ?? 0,
        lastImportAt: body.lastImportAt ?? null,
        readingsToday: body.readingsToday ?? 0
      });
      setClimateSummaryError(null);
    } catch {
      setClimateSummaryError("Network error while loading climate import status.");
    } finally {
      setClimateSummaryLoading(false);
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
        body: JSON.stringify({ organizationId: selectedOrganizationId, label: keyLabel.trim(), dataSourceType: keyDataSourceType })
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

  function toggleKeySelection(id: string) {
    setSelectedKeyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllRevokedKeys() {
    setSelectedKeyIds((prev) => {
      const next = new Set(prev);
      if (allVisibleRevokedSelected) {
        for (const k of visibleRevokedRows) next.delete(k.id);
      } else {
        for (const k of visibleRevokedRows) next.add(k.id);
      }
      return next;
    });
  }

  function handleDeleteKeys(ids: string[]) {
    if (ids.length === 0 || keyDeleteBusy) return;
    setKeyDeleteConfirm({ ids });
  }

  async function executeDeleteKeys(ids: string[]) {
    setKeyDeleteBusy(true);
    setManagementError(null);
    setKeyDeleteResult(null);
    let deletedCount = 0;
    const errors: string[] = [];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await apiFetch(`/api/admin/upload-keys/${id}`, { method: "DELETE" });
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          if (!res.ok) {
            errors.push(getResponseMessage(body, "Failed to delete upload key."));
          } else {
            deletedCount++;
          }
        } catch {
          errors.push("Network error deleting upload key.");
        }
      })
    );
    setKeyDeleteBusy(false);
    if (errors.length > 0) {
      setManagementError(errors[0]);
    }
    if (deletedCount > 0) {
      setKeyDeleteResult(`Permanently deleted ${deletedCount} upload key${deletedCount === 1 ? "" : "s"}.`);
      await loadKeys();
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
    setSelectedImportRunIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const r of filteredImportRuns) next.delete(r.id);
      } else {
        for (const r of filteredImportRuns) next.add(r.id);
      }
      return next;
    });
  }

  function handleDeleteSelectedImportRuns() {
    if (selectedImportRunIds.size === 0 || deleteImportRunsBusy) return;
    const ids = Array.from(selectedImportRunIds);
    const count = ids.length;
    setImportDeleteConfirm({ title: `Delete ${count} selected import run${count === 1 ? "" : "s"}?`, ids });
  }

  function handleDeleteWeekImportRuns() {
    if (filteredImportRuns.length === 0 || deleteImportRunsBusy) return;
    const ids = filteredImportRuns.map((r) => r.id);
    const count = ids.length;
    const parts: string[] = [];
    if (filterYear) parts.push(filterYear);
    if (filterWeek) parts.push(`Week ${String(filterWeek).padStart(2, "0")}`);
    const suffix = parts.length > 0 ? ` for ${parts.join(" ")}` : "";
    setImportDeleteConfirm({ title: `Delete ${count} import run${count === 1 ? "" : "s"}${suffix}?`, ids });
  }

  async function executeDeleteImportRuns(ids: string[]) {
    setDeleteImportRunsBusy(true);
    setImportRunsError(null);
    setDeleteResult(null);
    try {
      const res = await apiFetch("/api/admin/flowmaster/import-runs/delete", {
        method: "POST",
        body: JSON.stringify({ ids })
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        deletedCount?: number;
      };
      if (!res.ok) {
        setImportRunsError(getResponseMessage(body, "Failed to delete import runs."));
        return;
      }
      const deleted = typeof body.deletedCount === "number" ? body.deletedCount : ids.length;
      setDeleteResult(`Deleted ${deleted} import run${deleted === 1 ? "" : "s"}.`);
      setSelectedImportRunIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
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
                    <th style={tableHeaderStyle}>Data Source</th>
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
                      <td style={tableCellStyle}>
                        <span style={row.dataSourceType === "generic_csv" ? genericCsvBadgeStyle : flowmasterBadgeStyle}>
                          {row.dataSourceType === "generic_csv" ? "Generic CSV" : "FlowMaster"}
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
          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "1fr 1fr 1fr auto" }}>
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
            <div>
              <label htmlFor="key-data-source" style={labelStyle}>Data Source</label>
              <select
                id="key-data-source"
                value={keyDataSourceType}
                onChange={(e) => setKeyDataSourceType(e.target.value)}
                style={inputStyle}
              >
                <option value="flowmaster">FlowMaster</option>
                <option value="generic_csv">Generic CSV</option>
              </select>
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
        {keyDeleteResult && <p style={successBannerStyle}>{keyDeleteResult}</p>}

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.65rem", flexWrap: "wrap", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", flexWrap: "wrap" }}>
              <h3 style={subheadingStyle}>Existing Keys</h3>
              {!keysLoading && keyRows.length > 0 && (
                <>
                  <span style={activeBadgeStyle}>Active: {agentHealth.activeKeys}</span>
                  <span style={revokedBadgeStyle}>Revoked: {revokedKeyCount}</span>
                </>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", flexWrap: "wrap" }}>
              {selectedRevokedIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleDeleteKeys(selectedRevokedIds)}
                  disabled={keyDeleteBusy}
                  style={smallDangerButtonStyle}
                >
                  {keyDeleteBusy ? "Deleting..." : `Delete selected (${selectedRevokedIds.length})`}
                </button>
              )}
              <label style={hideRevokedLabelStyle}>
                <input
                  type="checkbox"
                  checked={hideRevoked}
                  onChange={(e) => setHideRevoked(e.target.checked)}
                />
                Hide revoked
              </label>
            </div>
          </div>
          {keysLoading ? (
            <p style={mutedTextStyle}>Loading keys...</p>
          ) : displayedKeyRows.length === 0 ? (
            <p style={mutedTextStyle}>
              {keyRows.length === 0
                ? "No upload keys created yet."
                : "No active keys. Uncheck “Hide revoked” to see all keys."}
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={tableHeaderStyle}>
                      {visibleRevokedRows.length > 0 && (
                        <input
                          type="checkbox"
                          aria-label="Select all revoked keys"
                          checked={allVisibleRevokedSelected}
                          onChange={toggleSelectAllRevokedKeys}
                        />
                      )}
                    </th>
                    <th style={tableHeaderStyle}>Label</th>
                    <th style={tableHeaderStyle}>Organization</th>
                    <th style={tableHeaderStyle}>Status</th>
                    <th style={tableHeaderStyle}>Data Source</th>
                    <th style={tableHeaderStyle}>Created</th>
                    <th style={tableHeaderStyle}>Last Used</th>
                    <th style={tableHeaderStyle}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedKeyRows.map((row) => (
                    <tr key={row.id}>
                      <td style={tableCellStyle}>
                        {row.status === "revoked" && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.label}`}
                            checked={selectedKeyIds.has(row.id)}
                            onChange={() => toggleKeySelection(row.id)}
                          />
                        )}
                      </td>
                      <td style={tableCellStyle}>{row.label}</td>
                      <td style={tableCellStyle}>{row.organizationName}</td>
                      <td style={tableCellStyle}>
                        <span style={row.status === "active" ? activeBadgeStyle : revokedBadgeStyle}>
                          {row.status}
                        </span>
                      </td>
                      <td style={tableCellStyle}>
                        <span style={row.dataSourceType === "generic_csv" ? genericCsvBadgeStyle : flowmasterBadgeStyle}>
                          {row.dataSourceType === "generic_csv" ? "Generic CSV" : "FlowMaster"}
                        </span>
                      </td>
                      <td style={tableCellStyle}>{formatDateTime(row.createdAt)}</td>
                      <td style={tableCellStyle}>{formatDateTime(row.lastUsedAt)}</td>
                      <td style={tableCellStyle}>
                        {row.status === "active" ? (
                          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                            {row.dataSourceType === "generic_csv" && (
                              <Link
                                to={`/admin/import-templates/${row.id}`}
                                style={row.hasTemplate ? configuredLinkStyle : configureLinkStyle}
                              >
                                {row.hasTemplate ? "Edit mapping" : "Configure import"}
                              </Link>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleRevokeKey(row.id)}
                              disabled={revokeBusyId === row.id}
                              style={smallDangerButtonStyle}
                            >
                              {revokeBusyId === row.id ? "Revoking..." : "Revoke"}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleDeleteKeys([row.id])}
                            disabled={keyDeleteBusy}
                            style={smallDangerButtonStyle}
                          >
                            Delete
                          </button>
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
          Lot-level import history. Deleting records allows the agent to re-queue those lots for review.
        </p>
        <p style={warningTextStyle}>
          Deleting import history does not delete yield entries. Use this when entries were deleted
          and the same files need to be resent.
        </p>

        {importRunsError && <p style={errorBannerStyle}>{importRunsError}</p>}
        {deleteResult && <p style={successBannerStyle}>{deleteResult}</p>}

        <div style={{ ...cardStyle, marginBottom: "0.75rem" }}>
          <h3 style={{ ...subheadingStyle, marginBottom: "0.65rem" }}>Filters</h3>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <label htmlFor="filter-year" style={labelStyle}>Year</label>
              <select
                id="filter-year"
                value={filterYear}
                onChange={(e) => {
                  setFilterYear(e.target.value);
                  setFilterWeek("");
                  setDeleteResult(null);
                }}
                style={{ ...inputStyle, width: "auto", minWidth: 100 }}
              >
                <option value="">All years</option>
                {availableYears.map((y) => (
                  <option key={y} value={String(y)}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="filter-week" style={labelStyle}>Week</label>
              <select
                id="filter-week"
                value={filterWeek}
                onChange={(e) => { setFilterWeek(e.target.value); setDeleteResult(null); }}
                disabled={!filterYear}
                style={{ ...inputStyle, width: "auto", minWidth: 100 }}
              >
                <option value="">All weeks</option>
                {availableWeeks.map((w) => (
                  <option key={w} value={String(w)}>Week {w}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="filter-filename" style={labelStyle}>Source file (optional)</label>
              <input
                id="filter-filename"
                type="text"
                value={filterFilename}
                onChange={(e) => { setFilterFilename(e.target.value); setDeleteResult(null); }}
                placeholder="e.g. Packline_W22.pdf"
                style={{ ...inputStyle, width: 220 }}
              />
            </div>
            <button
              type="button"
              onClick={() => { setFilterYear(""); setFilterWeek(""); setFilterFilename(""); setDeleteResult(null); }}
              disabled={!filterYear && !filterWeek && !filterFilename}
              style={{ ...secondaryButtonStyle, marginTop: 0 }}
            >
              Clear filters
            </button>
          </div>

          {(filterYear || filterWeek || filterFilename) && (
            <p style={{ ...mutedTextStyle, marginTop: "0.5rem" }}>
              Showing {filteredImportRuns.length} of {importRuns.length} import run
              {importRuns.length === 1 ? "" : "s"}
            </p>
          )}
        </div>

        <div style={cardStyle}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "0.75rem",
              alignItems: "center",
              marginBottom: "0.75rem",
              flexWrap: "wrap"
            }}
          >
            <h3 style={subheadingStyle}>Runs</h3>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void loadImportRuns()}
                disabled={importRunsLoading || deleteImportRunsBusy}
                style={{ ...secondaryButtonStyle, marginTop: 0 }}
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={handleDeleteWeekImportRuns}
                disabled={filteredImportRuns.length === 0 || deleteImportRunsBusy}
                style={smallDangerButtonStyle}
                title="Delete import history for all currently filtered runs"
              >
                {deleteImportRunsBusy
                  ? "Deleting..."
                  : filterYear && filterWeek
                    ? `Delete history for ${filterYear}-W${String(filterWeek).padStart(2, "0")} (${filteredImportRuns.length})`
                    : `Delete filtered (${filteredImportRuns.length})`}
              </button>
              <button
                type="button"
                onClick={handleDeleteSelectedImportRuns}
                disabled={selectedImportRunIds.size === 0 || deleteImportRunsBusy}
                style={{ ...smallDangerButtonStyle, background: "#7f1d1d" }}
                title="Delete only the individually checked rows"
              >
                {deleteImportRunsBusy
                  ? "Deleting..."
                  : `Delete selected (${selectedImportRunIds.size})`}
              </button>
            </div>
          </div>

          {importRunsLoading ? (
            <p style={mutedTextStyle}>Loading import history...</p>
          ) : filteredImportRuns.length === 0 ? (
            <p style={mutedTextStyle}>
              {importRuns.length === 0 ? "No imports found." : "No runs match the current filters."}
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={tableHeaderStyle}>
                      <input
                        type="checkbox"
                        aria-label="Select all visible import runs"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAllImportRuns}
                      />
                    </th>
                    <th style={tableHeaderStyle}>Source File</th>
                    <th style={tableHeaderStyle}>Lot Number</th>
                    <th style={tableHeaderStyle}>Variety</th>
                    <th style={tableHeaderStyle}>Year / Week</th>
                    <th style={tableHeaderStyle}>Start Time</th>
                    <th style={tableHeaderStyle}>Imported At</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredImportRuns.map((run) => (
                    <tr key={run.id}>
                      <td style={tableCellStyle}>
                        <input
                          type="checkbox"
                          aria-label={`Select lot ${run.lotNumber}`}
                          checked={selectedImportRunIds.has(run.id)}
                          onChange={() => toggleImportRunSelection(run.id)}
                        />
                      </td>
                      <td style={tableCellStyle}>{run.sourceFilename ?? "—"}</td>
                      <td style={tableCellStyle}>{run.lotNumber}</td>
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

      {/* ── Section 6: Climate Agent ──────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Climate Agent</h2>
        <p style={descriptionStyle}>
          Import status for the requesting admin's organization. Scoped the same way as FlowMaster
          import history above.
        </p>
        {climateSummaryError && <p style={errorBannerStyle}>{climateSummaryError}</p>}
        {climateSummaryLoading ? (
          <p style={mutedTextStyle}>Loading climate import status...</p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: "0.75rem"
            }}
          >
            <StatCard label="Total Climate Imports" value={String(climateSummary?.totalImports ?? 0)} />
            <StatCard label="Readings Today" value={String(climateSummary?.readingsToday ?? 0)} />
            <StatCard
              label="Last Climate Import"
              value={climateSummary?.lastImportAt ? formatDateTime(climateSummary.lastImportAt) : "—"}
            />
          </div>
        )}
      </section>

      {keyDeleteConfirm && (
        <div style={modalOverlayStyle}>
          <div style={modalPanelStyle}>
            <h3 style={modalTitleStyle}>
              Permanently delete {keyDeleteConfirm.ids.length} upload key{keyDeleteConfirm.ids.length === 1 ? "" : "s"}?
            </h3>
            <p style={modalBodyStyle}>This cannot be undone.</p>
            <p style={modalBodyStyle}>Related import templates will also be removed. Historical import records are kept.</p>
            <div style={modalActionsStyle}>
              <button type="button" onClick={() => setKeyDeleteConfirm(null)} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const ids = keyDeleteConfirm.ids;
                  setKeyDeleteConfirm(null);
                  void executeDeleteKeys(ids);
                }}
                style={modalDangerButtonStyle}
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {importDeleteConfirm && (
        <div style={modalOverlayStyle}>
          <div style={modalPanelStyle}>
            <h3 style={modalTitleStyle}>{importDeleteConfirm.title}</h3>
            <p style={modalBodyStyle}>This only deletes import history.</p>
            <p style={modalBodyStyle}>Yield entries will not be deleted.</p>
            <p style={modalBodyStyle}>Deleting import history allows the same lots/files to be resent and appear in pending imports again.</p>
            <div style={modalActionsStyle}>
              <button type="button" onClick={() => setImportDeleteConfirm(null)} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const ids = importDeleteConfirm.ids;
                  setImportDeleteConfirm(null);
                  void executeDeleteImportRuns(ids);
                }}
                style={modalDangerButtonStyle}
              >
                Delete Import History
              </button>
            </div>
          </div>
        </div>
      )}
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

const successBannerStyle: CSSProperties = {
  margin: "0 0 0.5rem",
  padding: "0.55rem 0.7rem",
  background: "#e8f8ef",
  border: "1px solid #bfe9cf",
  borderRadius: 6,
  fontSize: "0.82rem",
  color: "#1f7a42"
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

const flowmasterBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "var(--surface-soft)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)"
};

const genericCsvBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "#eef4ff",
  color: "#1a4a8f",
  border: "1px solid #b8d0f7"
};

const configureLinkStyle: CSSProperties = {
  fontSize: "0.78rem",
  color: "#c0392b",
  textDecoration: "none",
  fontWeight: 600,
  padding: "0.2rem 0.4rem",
  border: "1px solid #f5c6c6",
  borderRadius: 5,
  background: "#fdf2f2",
  whiteSpace: "nowrap"
};

const configuredLinkStyle: CSSProperties = {
  fontSize: "0.78rem",
  color: "#1a4a8f",
  textDecoration: "none",
  fontWeight: 500,
  padding: "0.2rem 0.4rem",
  border: "1px solid #b8d0f7",
  borderRadius: 5,
  background: "#eef4ff",
  whiteSpace: "nowrap"
};

const hideRevokedLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.8rem",
  cursor: "pointer",
  userSelect: "none",
  color: "var(--text-muted)"
};

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalPanelStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "1.5rem",
  maxWidth: 420,
  width: "calc(100% - 2rem)",
};

const modalTitleStyle: CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 600,
  color: "var(--text)",
  margin: "0 0 0.75rem",
};

const modalBodyStyle: CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--text-muted)",
  margin: "0 0 0.4rem",
};

const modalActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.6rem",
  justifyContent: "flex-end",
  marginTop: "1.25rem",
};

const modalDangerButtonStyle: CSSProperties = {
  padding: "0.45rem 0.8rem",
  background: "#c0392b",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.875rem",
  fontWeight: 600,
};
