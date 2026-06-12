import { FormEvent, useEffect, useState, type CSSProperties } from "react";
import { apiFetch } from "../lib/api";

type IntegrationRow = {
  organizationId: string;
  organizationName: string;
  integrationId: string | null;
  externalOrganizationId: string | null;
  enabled: boolean;
  connected: boolean;
  lastCasesSync: string | null;
  lastWasteSync: string | null;
  connectedByUserId: string | null;
  connectedByEmail: string | null;
  connectedAt: string | null;
};

type DocklinkOrg = {
  id: string;
  name: string;
};

type ViewTestResult = { ok: boolean; rowCount?: number; error?: string };

type TestResult = {
  casesView: ViewTestResult;
  wasteView: ViewTestResult;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string };

type ModalState =
  | { kind: "closed" }
  | {
      kind: "connect";
      organizationId: string;
      organizationName: string;
      currentExternalId: string | null;
    };

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

export function AdminDocklinkIntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [docklinkOrgs, setDocklinkOrgs] = useState<DocklinkOrg[]>([]);
  const [dlOrgsLoading, setDlOrgsLoading] = useState(true);
  const [dlOrgsError, setDlOrgsError] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalState>({ kind: "closed" });
  const [selectedDlOrgId, setSelectedDlOrgId] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

  const [testResults, setTestResults] = useState<Map<string, TestResult>>(new Map());
  const [testingId, setTestingId] = useState<string | null>(null);
  const [disablingId, setDisablingId] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([loadIntegrations(), loadDocklinkOrgs()]);
  }, []);

  async function loadIntegrations() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/admin/docklink-integrations");
      const body = (await res.json().catch(() => ({}))) as {
        integrations?: IntegrationRow[];
        message?: string;
      };
      if (!res.ok) {
        setLoadError(getResponseMessage(body, "Failed to load DockLink integrations."));
        return;
      }
      setIntegrations(Array.isArray(body.integrations) ? body.integrations : []);
    } catch {
      setLoadError("Network error while loading integrations.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDocklinkOrgs() {
    setDlOrgsLoading(true);
    setDlOrgsError(null);
    try {
      const res = await apiFetch("/api/admin/docklink-organizations");
      const body = (await res.json().catch(() => ({}))) as {
        organizations?: DocklinkOrg[];
        message?: string;
      };
      if (res.status === 503) {
        setDlOrgsError("DockLink is not configured on this server.");
        return;
      }
      if (!res.ok) {
        setDlOrgsError(getResponseMessage(body, "Failed to load DockLink organizations."));
        return;
      }
      setDocklinkOrgs(Array.isArray(body.organizations) ? body.organizations : []);
    } catch {
      setDlOrgsError("Network error while loading DockLink organizations.");
    } finally {
      setDlOrgsLoading(false);
    }
  }

  function getDlOrg(externalId: string | null): DocklinkOrg | undefined {
    if (!externalId) return undefined;
    return docklinkOrgs.find((o) => o.id === externalId);
  }

  function openConnectModal(row: IntegrationRow) {
    setModal({
      kind: "connect",
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      currentExternalId: row.externalOrganizationId
    });
    setSelectedDlOrgId(row.externalOrganizationId ?? "");
    setSaveState({ kind: "idle" });
  }

  function closeModal() {
    setModal({ kind: "closed" });
    setSaveState({ kind: "idle" });
  }

  async function handleRefresh() {
    await Promise.all([loadIntegrations(), loadDocklinkOrgs()]);
  }

  async function handleSaveConnection(e: FormEvent) {
    e.preventDefault();
    if (modal.kind !== "connect") return;

    if (!selectedDlOrgId) {
      setSaveState({ kind: "error", message: "Select a DockLink organization." });
      return;
    }

    setSaveState({ kind: "loading" });

    try {
      const res = await apiFetch("/api/admin/docklink-integrations", {
        method: "POST",
        body: JSON.stringify({
          organizationId: modal.organizationId,
          externalOrganizationId: selectedDlOrgId
        })
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setSaveState({ kind: "error", message: getResponseMessage(body, "Failed to save integration.") });
        return;
      }
      setSaveState({ kind: "success", message: getResponseMessage(body, "Integration saved.") });
      await loadIntegrations();
      setTimeout(() => closeModal(), 1200);
    } catch {
      setSaveState({ kind: "error", message: "Network error while saving integration." });
    }
  }

  async function handleTest(integrationId: string) {
    setTestingId(integrationId);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/admin/docklink-integrations/${integrationId}/test`, {
        method: "POST"
      });
      const body = (await res.json().catch(() => ({}))) as Partial<TestResult> & {
        message?: string;
      };

      if (!res.ok) {
        // 503/404 — no per-view data, synthesise an error result
        const msg = getResponseMessage(body, "Test failed.");
        setTestResults(
          (prev) =>
            new Map(prev).set(integrationId, {
              casesView: { ok: false, error: msg },
              wasteView: { ok: false, error: msg }
            })
        );
        return;
      }

      setTestResults(
        (prev) =>
          new Map(prev).set(integrationId, {
            casesView: body.casesView ?? { ok: false, error: "No result" },
            wasteView: body.wasteView ?? { ok: false, error: "No result" }
          })
      );
    } catch {
      setTestResults(
        (prev) =>
          new Map(prev).set(integrationId, {
            casesView: { ok: false, error: "Network error" },
            wasteView: { ok: false, error: "Network error" }
          })
      );
    } finally {
      setTestingId(null);
    }
  }

  async function handleDisable(integrationId: string, orgName: string) {
    const confirmed = window.confirm(
      `Disable DockLink integration for "${orgName}"?\n\nSyncs will stop working until the integration is reconnected.`
    );
    if (!confirmed) return;

    setDisablingId(integrationId);
    setActionError(null);
    try {
      const res = await apiFetch(
        `/api/admin/docklink-integrations/${integrationId}/disable`,
        { method: "POST" }
      );
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setActionError(getResponseMessage(body, "Failed to disable integration."));
        return;
      }
      await loadIntegrations();
    } catch {
      setActionError("Network error while disabling integration.");
    } finally {
      setDisablingId(null);
    }
  }

  const selectedDlOrg = getDlOrg(selectedDlOrgId);
  const dropdownReady = !dlOrgsLoading && !dlOrgsError;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem 1rem 2rem" }}>
      <section style={sectionStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: "0.8rem",
            flexWrap: "wrap",
            gap: "0.5rem"
          }}
        >
          <div>
            <h2 style={titleStyle}>DockLink Integrations</h2>
            <p style={descriptionStyle}>
              Manage which GrowLink organizations are connected to DockLink for automatic data sync.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            style={secondaryButtonStyle}
            disabled={loading || dlOrgsLoading}
          >
            Refresh
          </button>
        </div>

        {loadError && <p style={errorBannerStyle}>{loadError}</p>}
        {actionError && <p style={errorBannerStyle}>{actionError}</p>}

        <div style={cardStyle}>
          {loading ? (
            <p style={{ margin: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>
              Loading integrations...
            </p>
          ) : integrations.length === 0 ? (
            <p style={{ margin: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>
              No organizations found.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={tableHeaderStyle}>GrowLink Organization</th>
                    <th style={tableHeaderStyle}>DockLink Organization</th>
                    <th style={tableHeaderStyle}>Status</th>
                    <th style={tableHeaderStyle}>Last Cases Sync</th>
                    <th style={tableHeaderStyle}>Last Waste Sync</th>
                    <th style={tableHeaderStyle}>Connected By</th>
                    <th style={tableHeaderStyle}>Connected On</th>
                    <th style={tableHeaderStyle}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {integrations.map((row) => {
                    const testResult = row.integrationId
                      ? testResults.get(row.integrationId)
                      : undefined;

                    const statusBadge = row.connected
                      ? row.enabled
                        ? connectedBadgeStyle
                        : disabledBadgeStyle
                      : notConnectedBadgeStyle;

                    const statusLabel = row.connected
                      ? row.enabled
                        ? "Connected"
                        : "Disabled"
                      : "Not connected";

                    const dlOrg = getDlOrg(row.externalOrganizationId);

                    return (
                      <tr key={row.organizationId}>
                        <td style={tableCellStyle}>
                          <div style={{ fontWeight: 500 }}>{row.organizationName}</div>
                          <div style={monoMutedStyle}>{row.organizationId}</div>
                        </td>
                        <td style={tableCellStyle}>
                          {row.externalOrganizationId ? (
                            <>
                              <div style={{ fontWeight: 500 }}>
                                {dlOrg?.name ?? row.externalOrganizationId}
                              </div>
                              {dlOrg && (
                                <div style={monoMutedStyle}>{row.externalOrganizationId}</div>
                              )}
                            </>
                          ) : (
                            <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                              Not connected
                            </span>
                          )}
                        </td>
                        <td style={tableCellStyle}>
                          <span style={statusBadge}>{statusLabel}</span>
                        </td>
                        <td style={tableCellStyle}>{formatDateTime(row.lastCasesSync)}</td>
                        <td style={tableCellStyle}>{formatDateTime(row.lastWasteSync)}</td>
                        <td style={tableCellStyle}>
                          {row.connectedByEmail ? (
                            row.connectedByEmail
                          ) : row.connectedByUserId ? (
                            <span style={monoMutedStyle}>{row.connectedByUserId}</span>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>—</span>
                          )}
                        </td>
                        <td style={tableCellStyle}>{formatDateTime(row.connectedAt)}</td>
                        <td style={tableCellStyle}>
                          <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => openConnectModal(row)}
                              style={smallActionButtonStyle}
                            >
                              {row.connected ? "Change" : "Connect"}
                            </button>
                            {row.integrationId !== null && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void handleTest(row.integrationId as string)}
                                  disabled={testingId === row.integrationId}
                                  style={smallActionButtonStyle}
                                >
                                  {testingId === row.integrationId ? "Testing..." : "Test"}
                                </button>
                                {row.enabled && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleDisable(
                                        row.integrationId as string,
                                        row.organizationName
                                      )
                                    }
                                    disabled={disablingId === row.integrationId}
                                    style={smallDangerButtonStyle}
                                  >
                                    {disablingId === row.integrationId ? "Disabling..." : "Disable"}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                          {testResult !== undefined && (
                            <div style={{ marginTop: "0.35rem" }}>
                              <ViewResultLine label="Cases view" result={testResult.casesView} />
                              <ViewResultLine label="Waste view" result={testResult.wasteView} />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {modal.kind === "connect" && (
        <div style={modalOverlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem", color: "var(--text)" }}>
              {modal.currentExternalId ? "Change DockLink Connection" : "Connect to DockLink"}
            </h3>

            <form onSubmit={handleSaveConnection}>
              <div style={{ marginBottom: "0.85rem" }}>
                <label htmlFor="dl-org-select" style={labelStyle}>
                  DockLink Organization <span style={{ color: "#c0392b" }}>*</span>
                </label>

                {dlOrgsLoading ? (
                  <p style={{ margin: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>
                    Loading DockLink organizations...
                  </p>
                ) : dlOrgsError ? (
                  <p style={errorBannerStyle}>{dlOrgsError}</p>
                ) : docklinkOrgs.length === 0 ? (
                  <p style={{ margin: "0.25rem 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>
                    No organizations found in DockLink.
                  </p>
                ) : (
                  <select
                    id="dl-org-select"
                    value={selectedDlOrgId}
                    onChange={(e) => setSelectedDlOrgId(e.target.value)}
                    style={selectStyle}
                    autoFocus
                    required
                  >
                    <option value="">— Select a DockLink organization —</option>
                    {docklinkOrgs.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {selectedDlOrgId && dropdownReady && (
                <div style={confirmationCardStyle}>
                  <p style={{ margin: "0 0 0.2rem", fontSize: "0.82rem", fontWeight: 600 }}>
                    You are connecting:
                  </p>
                  <p style={{ margin: "0.1rem 0", fontSize: "0.82rem" }}>
                    <span style={{ color: "var(--text-muted)" }}>GrowLink:</span>{" "}
                    <strong>{modal.organizationName}</strong>
                  </p>
                  <p style={{ margin: "0.1rem 0 0", fontSize: "0.82rem" }}>
                    <span style={{ color: "var(--text-muted)" }}>DockLink:</span>{" "}
                    <strong>{selectedDlOrg?.name ?? selectedDlOrgId}</strong>
                  </p>
                </div>
              )}

              {saveState.kind === "error" && (
                <p style={errorBannerStyle}>{saveState.message}</p>
              )}
              {saveState.kind === "success" && (
                <p
                  style={{
                    ...errorBannerStyle,
                    background: "var(--brand-soft)",
                    border: "1px solid var(--brand)",
                    color: "var(--brand)"
                  }}
                >
                  {saveState.message}
                </p>
              )}

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                <button
                  type="submit"
                  disabled={saveState.kind === "loading" || !dropdownReady || !selectedDlOrgId}
                  style={{ ...primaryButtonStyle, flex: 1 }}
                >
                  {saveState.kind === "loading" ? "Saving..." : "Save connection"}
                </button>
                <button type="button" onClick={closeModal} style={cancelButtonStyle}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ViewResultLine({
  label,
  result
}: {
  label: string;
  result: ViewTestResult;
}) {
  const icon = result.ok ? "✓" : "✕";
  const color = result.ok ? "#1f7a42" : "#c0392b";
  const detail = result.ok
    ? result.rowCount !== undefined
      ? ` (${result.rowCount} row${result.rowCount === 1 ? "" : "s"})`
      : ""
    : result.error
      ? `: ${result.error}`
      : "";

  return (
    <div style={{ fontSize: "0.75rem", color, lineHeight: 1.4 }}>
      {icon} {label}{detail}
    </div>
  );
}

const monoMutedStyle: CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--text-muted)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
};

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
  marginBottom: 0,
  marginTop: 0
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "0.9rem"
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  fontWeight: 500,
  marginBottom: "0.3rem"
};

const selectStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.65rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.9rem",
  color: "var(--text)",
  background: "var(--surface-soft)",
  outline: "none",
  boxSizing: "border-box"
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

const cancelButtonStyle: CSSProperties = {
  padding: "0.6rem 0.75rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.88rem",
  fontWeight: 500
};

const smallActionButtonStyle: CSSProperties = {
  padding: "0.3rem 0.55rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.78rem",
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
  verticalAlign: "top"
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

const disabledBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "#f9eaea",
  color: "#8f2d1f",
  border: "1px solid #f0c5be"
};

const notConnectedBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "var(--surface-soft)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)"
};

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem"
};

const modalStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "1.25rem",
  width: "100%",
  maxWidth: 460,
  boxShadow: "0 8px 32px rgba(0,0,0,0.18)"
};

const confirmationCardStyle: CSSProperties = {
  background: "#f0f7ff",
  border: "1px solid #bcd7f7",
  borderRadius: 6,
  padding: "0.6rem 0.75rem",
  marginBottom: "0.75rem"
};
