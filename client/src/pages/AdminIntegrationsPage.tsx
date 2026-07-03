import { FormEvent, ReactNode, useEffect, useMemo, useState, type CSSProperties } from "react";
import { apiFetch } from "../lib/api";

type IntegrationStatus = "available" | "coming-soon" | "future";

type IntegrationDefinition = {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
};

// Only CropLink is wired up today. Add future integrations here — the card
// rendering below is generic and does not hardcode any integration name.
const INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: "croplink",
    name: "CropLink",
    description: "Read-only harvest actuals and variety data consumed by CropLink.",
    status: "available"
  },
  {
    id: "labourlink",
    name: "LabourLink",
    description: "Labour tracking integration.",
    status: "coming-soon"
  },
  {
    id: "weather-stations",
    name: "Weather Stations",
    description: "Third-party weather station data providers.",
    status: "future"
  },
  {
    id: "accounting",
    name: "Accounting",
    description: "Accounting/ERP export integration.",
    status: "future"
  }
];

type OrganizationOption = {
  id: string;
  name: string;
};

type IntegrationKeyRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  integrationName: string;
  label: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

type CreatedKeyState = {
  key: string;
  label: string;
  organizationName: string;
  integrationDisplayName: string;
};

type GenerateDialogState = {
  integrationId: string;
  integrationDisplayName: string;
  organizationId: string;
  label: string;
  submitting: boolean;
  error: string | null;
};

type IntegrationConfigStatus = "not-configured" | "active" | "revoked";
type IntegrationHealthLevel = "healthy" | "stale" | "never-used" | "offline";

type IntegrationHealth = {
  configStatus: IntegrationConfigStatus;
  health: IntegrationHealthLevel;
  lastUsedAt: string | null;
  activeCount: number;
  totalCount: number;
};

type TestResult = {
  ok: boolean;
  message: string;
  testedAt: string;
};

const HEALTHY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// Health is derived entirely from key status + last_used_at — no new schema,
// no new backend endpoint. "Offline / Not Configured" deliberately covers
// both the zero-keys case and the all-revoked case: from CropLink's
// perspective those are indistinguishable (no active key = no access).
function computeIntegrationHealth(keys: IntegrationKeyRow[]): IntegrationHealth {
  const activeKeys = keys.filter((k) => k.status === "active");
  const totalCount = keys.length;
  const activeCount = activeKeys.length;

  const configStatus: IntegrationConfigStatus =
    totalCount === 0 ? "not-configured" : activeCount > 0 ? "active" : "revoked";

  let lastUsedAt: string | null = null;
  for (const key of activeKeys) {
    if (key.lastUsedAt && (!lastUsedAt || key.lastUsedAt > lastUsedAt)) {
      lastUsedAt = key.lastUsedAt;
    }
  }

  let health: IntegrationHealthLevel;
  if (activeCount === 0) {
    health = "offline";
  } else if (!lastUsedAt) {
    health = "never-used";
  } else {
    const ageMs = Date.now() - new Date(lastUsedAt).getTime();
    health = ageMs <= HEALTHY_THRESHOLD_MS ? "healthy" : "stale";
  }

  return { configStatus, health, lastUsedAt, activeCount, totalCount };
}

const CONFIG_STATUS_LABEL: Record<IntegrationConfigStatus, string> = {
  "not-configured": "Not Configured",
  active: "Active",
  revoked: "Revoked"
};

const HEALTH_LABEL: Record<IntegrationHealthLevel, string> = {
  healthy: "Healthy",
  stale: "Stale",
  "never-used": "Never Used",
  offline: "Offline / Not Configured"
};

function getResponseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const maybeMessage = (body as { message?: unknown }).message;
  return typeof maybeMessage === "string" && maybeMessage.trim().length > 0
    ? maybeMessage
    : fallback;
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

export function AdminIntegrationsPage() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [keyRows, setKeyRows] = useState<IntegrationKeyRow[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const [generateDialog, setGenerateDialog] = useState<GenerateDialogState | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedKeyState | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<IntegrationKeyRow | null>(null);
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<IntegrationKeyRow | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [testBusyId, setTestBusyId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const keysByIntegration = useMemo(() => {
    const map = new Map<string, IntegrationKeyRow[]>();
    for (const row of keyRows) {
      const list = map.get(row.integrationName) ?? [];
      list.push(row);
      map.set(row.integrationName, list);
    }
    return map;
  }, [keyRows]);

  useEffect(() => {
    void loadOrganizations();
    void loadKeys();
  }, []);

  async function loadOrganizations() {
    try {
      const res = await apiFetch("/api/admin/organizations");
      const body = (await res.json().catch(() => ({}))) as { organizations?: OrganizationOption[] };
      if (!res.ok) return;
      setOrganizations(Array.isArray(body.organizations) ? body.organizations : []);
    } catch {
      // non-fatal — organization dropdown just stays empty
    }
  }

  async function loadKeys() {
    setKeysLoading(true);
    try {
      const res = await apiFetch("/api/admin/integration-keys");
      const body = (await res.json().catch(() => ({}))) as { keys?: IntegrationKeyRow[] };
      if (!res.ok) {
        setLoadError("Failed to load integration keys.");
        return;
      }
      setKeyRows(Array.isArray(body.keys) ? body.keys : []);
      setLoadError(null);
    } catch {
      setLoadError("Network error while loading integration keys.");
    } finally {
      setKeysLoading(false);
    }
  }

  // Placeholder for a real health check — CropLink doesn't expose a sync
  // status endpoint yet. This just re-confirms an active key is on file via
  // the same admin list endpoint the page already uses.
  async function handleTest(def: IntegrationDefinition) {
    setTestBusyId(def.id);
    try {
      const res = await apiFetch("/api/admin/integration-keys");
      const body = (await res.json().catch(() => ({}))) as { message?: string; keys?: IntegrationKeyRow[] };
      const testedAt = new Date().toISOString();
      if (!res.ok) {
        setTestResults((prev) => ({
          ...prev,
          [def.id]: { ok: false, message: getResponseMessage(body, "Failed to reach GrowLink."), testedAt }
        }));
        return;
      }
      const freshKeys = Array.isArray(body.keys) ? body.keys : [];
      setKeyRows(freshKeys);
      const activeCount = freshKeys.filter(
        (k) => k.integrationName === def.id && k.status === "active"
      ).length;
      setTestResults((prev) => ({
        ...prev,
        [def.id]: activeCount > 0
          ? { ok: true, message: `Connected — ${activeCount} active key${activeCount === 1 ? "" : "s"} found.`, testedAt }
          : { ok: false, message: "No active keys found for this integration.", testedAt }
      }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [def.id]: { ok: false, message: "Network error while testing integration.", testedAt: new Date().toISOString() }
      }));
    } finally {
      setTestBusyId(null);
    }
  }

  function openGenerateDialog(def: IntegrationDefinition) {
    setActionError(null);
    setActionResult(null);
    setGenerateDialog({
      integrationId: def.id,
      integrationDisplayName: def.name,
      organizationId: organizations[0]?.id ?? "",
      label: "",
      submitting: false,
      error: null
    });
  }

  async function handleGenerateSubmit(e: FormEvent) {
    e.preventDefault();
    if (!generateDialog) return;

    if (!generateDialog.organizationId) {
      setGenerateDialog({ ...generateDialog, error: "Select an organization first." });
      return;
    }
    if (!generateDialog.label.trim()) {
      setGenerateDialog({ ...generateDialog, error: "A label is required." });
      return;
    }

    setGenerateDialog({ ...generateDialog, submitting: true, error: null });
    try {
      const res = await apiFetch("/api/admin/integration-keys", {
        method: "POST",
        body: JSON.stringify({
          organizationId: generateDialog.organizationId,
          label: generateDialog.label.trim(),
          integrationName: generateDialog.integrationId
        })
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; key?: string };
      if (!res.ok) {
        setGenerateDialog({
          ...generateDialog,
          submitting: false,
          error: getResponseMessage(body, "Failed to create integration key.")
        });
        return;
      }

      const org = organizations.find((o) => o.id === generateDialog.organizationId);
      setCreatedKey({
        key: typeof body.key === "string" ? body.key : "",
        label: generateDialog.label.trim(),
        organizationName: org?.name ?? "Unknown",
        integrationDisplayName: generateDialog.integrationDisplayName
      });
      setGenerateDialog(null);
      await loadKeys();
    } catch {
      setGenerateDialog({
        ...generateDialog,
        submitting: false,
        error: "Network error while creating integration key."
      });
    }
  }

  async function handleCopyRawKey() {
    if (!createdKey?.key) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
    } catch {
      setActionError("Failed to copy key to clipboard.");
    }
  }

  async function handleRevoke(row: IntegrationKeyRow) {
    setRevokeBusyId(row.id);
    setActionError(null);
    setActionResult(null);
    try {
      const res = await apiFetch(`/api/admin/integration-keys/${row.id}/revoke`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(getResponseMessage(body, "Failed to revoke integration key."));
        return;
      }
      setActionResult(`Revoked "${row.label}".`);
      await loadKeys();
    } catch {
      setActionError("Network error while revoking integration key.");
    } finally {
      setRevokeBusyId(null);
    }
  }

  async function handleDelete(row: IntegrationKeyRow) {
    setDeleteBusyId(row.id);
    setActionError(null);
    setActionResult(null);
    try {
      const res = await apiFetch(`/api/admin/integration-keys/${row.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(getResponseMessage(body, "Failed to delete integration key."));
        return;
      }
      setActionResult(`Permanently deleted "${row.label}".`);
      await loadKeys();
    } catch {
      setActionError("Network error while deleting integration key.");
    } finally {
      setDeleteBusyId(null);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "1.5rem 1rem 2rem" }}>
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Integrations</h2>
        <p style={descriptionStyle}>
          Manage read-only API keys that let other Denva products pull data from GrowLink.
        </p>
      </section>

      {loadError && <p style={errorBannerStyle}>{loadError}</p>}
      {actionError && <p style={errorBannerStyle}>{actionError}</p>}
      {actionResult && <p style={successBannerStyle}>{actionResult}</p>}

      {INTEGRATIONS.map((def) =>
        def.status === "available" ? (
          <IntegrationCard
            key={def.id}
            def={def}
            keys={keysByIntegration.get(def.id) ?? []}
            keysLoading={keysLoading}
            onGenerate={() => openGenerateDialog(def)}
            onRevoke={(row) => setRevokeConfirm(row)}
            onDelete={(row) => setDeleteConfirm(row)}
            revokeBusyId={revokeBusyId}
            deleteBusyId={deleteBusyId}
            onTest={() => void handleTest(def)}
            testBusy={testBusyId === def.id}
            testResult={testResults[def.id] ?? null}
          />
        ) : (
          <ComingSoonCard key={def.id} def={def} />
        )
      )}

      {generateDialog && (
        <div style={modalOverlayStyle}>
          <div style={modalPanelStyle}>
            <h3 style={modalTitleStyle}>Generate Integration Key</h3>
            <p style={modalBodyStyle}>{generateDialog.integrationDisplayName}</p>
            <form onSubmit={handleGenerateSubmit}>
              <div style={{ marginBottom: "0.75rem" }}>
                <label htmlFor="gen-key-org" style={labelStyle}>
                  Organization <span style={{ color: "#c0392b" }}>*</span>
                </label>
                <select
                  id="gen-key-org"
                  required
                  value={generateDialog.organizationId}
                  onChange={(e) =>
                    setGenerateDialog({ ...generateDialog, organizationId: e.target.value })
                  }
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
              <div style={{ marginBottom: "0.5rem" }}>
                <label htmlFor="gen-key-label" style={labelStyle}>
                  Label <span style={{ color: "#c0392b" }}>*</span>
                </label>
                <input
                  id="gen-key-label"
                  type="text"
                  required
                  value={generateDialog.label}
                  onChange={(e) => setGenerateDialog({ ...generateDialog, label: e.target.value })}
                  placeholder="e.g. CropLink Production"
                  style={inputStyle}
                />
              </div>
              {generateDialog.error && <p style={errorBannerStyle}>{generateDialog.error}</p>}
              <div style={modalActionsStyle}>
                <button
                  type="button"
                  onClick={() => setGenerateDialog(null)}
                  disabled={generateDialog.submitting}
                  style={secondaryButtonStyle}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={generateDialog.submitting || organizations.length === 0}
                  style={primaryButtonStyle}
                >
                  {generateDialog.submitting ? "Generating..." : "Generate key"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {createdKey && (
        <div style={modalOverlayStyle}>
          <div style={modalPanelStyle}>
            <h3 style={modalTitleStyle}>Integration Key</h3>
            <p style={modalBodyStyle}>
              {createdKey.integrationDisplayName} — {createdKey.label} ({createdKey.organizationName})
            </p>
            <p style={{ ...modalBodyStyle, fontWeight: 600, color: "var(--brand)" }}>
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
            <div style={modalActionsStyle}>
              <button type="button" onClick={handleCopyRawKey} style={secondaryButtonStyle}>
                Copy
              </button>
              <button type="button" onClick={() => setCreatedKey(null)} style={primaryButtonStyle}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {revokeConfirm && (
        <div style={modalOverlayStyle}>
          <div style={modalPanelStyle}>
            <h3 style={modalTitleStyle}>Revoke this integration key?</h3>
            <p style={modalBodyStyle}>
              This immediately prevents {revokeConfirm.integrationName} from accessing the API using
              &ldquo;{revokeConfirm.label}&rdquo;.
            </p>
            <div style={modalActionsStyle}>
              <button
                type="button"
                onClick={() => setRevokeConfirm(null)}
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const row = revokeConfirm;
                  setRevokeConfirm(null);
                  void handleRevoke(row);
                }}
                style={modalDangerButtonStyle}
              >
                Revoke
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div style={modalOverlayStyle}>
          <div style={modalPanelStyle}>
            <h3 style={modalTitleStyle}>Delete this integration key?</h3>
            <p style={modalBodyStyle}>
              This permanently deletes &ldquo;{deleteConfirm.label}&rdquo;. This cannot be undone.
            </p>
            <div style={modalActionsStyle}>
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const row = deleteConfirm;
                  setDeleteConfirm(null);
                  void handleDelete(row);
                }}
                style={modalDangerButtonStyle}
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IntegrationCard({
  def,
  keys,
  keysLoading,
  onGenerate,
  onRevoke,
  onDelete,
  revokeBusyId,
  deleteBusyId,
  onTest,
  testBusy,
  testResult
}: {
  def: IntegrationDefinition;
  keys: IntegrationKeyRow[];
  keysLoading: boolean;
  onGenerate: () => void;
  onRevoke: (row: IntegrationKeyRow) => void;
  onDelete: (row: IntegrationKeyRow) => void;
  revokeBusyId: string | null;
  deleteBusyId: string | null;
  onTest: () => void;
  testBusy: boolean;
  testResult: TestResult | null;
}) {
  const health = computeIntegrationHealth(keys);

  return (
    <section style={sectionStyle}>
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <div>
            <h3 style={subheadingStyle}>{def.name}</h3>
            <p style={{ ...descriptionStyle, marginBottom: 0 }}>{def.description}</p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" onClick={onTest} disabled={testBusy} style={secondaryButtonStyle}>
              {testBusy ? "Testing..." : "Test"}
            </button>
            {keys.length > 0 && (
              <button type="button" onClick={onGenerate} style={primaryButtonStyle}>
                Generate Integration Key
              </button>
            )}
          </div>
        </div>

        {/* ── 1. Integration health summary ──────────────────────────── */}
        <div style={healthSectionStyle}>
          <div style={healthGridStyle}>
            <HealthTile label="Status">
              <span style={CONFIG_STATUS_BADGE_STYLE[health.configStatus]}>
                {CONFIG_STATUS_LABEL[health.configStatus]}
              </span>
            </HealthTile>
            <HealthTile label="Health">
              <span style={HEALTH_BADGE_STYLE[health.health]}>{HEALTH_LABEL[health.health]}</span>
            </HealthTile>
            <HealthTile label="Last Used">
              <span style={healthValueTextStyle}>{formatDateTime(health.lastUsedAt)}</span>
            </HealthTile>
            <HealthTile label="Active Keys">
              <span style={healthValueTextStyle}>{health.activeCount}</span>
            </HealthTile>
            <HealthTile label="Total Keys">
              <span style={healthValueTextStyle}>{health.totalCount}</span>
            </HealthTile>
          </div>
          {testResult && (
            <p style={{ ...(testResult.ok ? successBannerStyle : errorBannerStyle), marginTop: "0.6rem", marginBottom: 0 }}>
              {testResult.message} (tested {formatDateTime(testResult.testedAt)})
            </p>
          )}
        </div>

        {/* ── 2. Keys list + 3. key actions ───────────────────────────── */}
        {keysLoading ? (
          <p style={mutedTextStyle}>Loading integration keys...</p>
        ) : keys.length === 0 ? (
          <div style={{ textAlign: "center", padding: "1.25rem 0" }}>
            <p style={mutedTextStyle}>No integration keys have been created.</p>
            <button type="button" onClick={onGenerate} style={primaryButtonStyle}>
              Generate First Key
            </button>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={tableHeaderStyle}>Organization</th>
                  <th style={tableHeaderStyle}>Label</th>
                  <th style={tableHeaderStyle}>Created</th>
                  <th style={tableHeaderStyle}>Last Used</th>
                  <th style={tableHeaderStyle}>Status</th>
                  <th style={tableHeaderStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((row) => (
                  <tr key={row.id}>
                    <td style={tableCellStyle}>{row.organizationName}</td>
                    <td style={tableCellStyle}>{row.label}</td>
                    <td style={tableCellStyle}>{formatDateTime(row.createdAt)}</td>
                    <td style={tableCellStyle}>{formatDateTime(row.lastUsedAt)}</td>
                    <td style={tableCellStyle}>
                      <span style={row.status === "active" ? activeBadgeStyle : revokedBadgeStyle}>
                        {row.status}
                      </span>
                    </td>
                    <td style={tableCellStyle}>
                      <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                        <div>
                          <button type="button" disabled style={disabledButtonStyle} title="Raw keys are only shown once, at creation time.">
                            Copy
                          </button>
                          <p style={copyHintStyle}>Generate a new key to obtain a new secret.</p>
                        </div>
                        {row.status === "active" ? (
                          <button
                            type="button"
                            onClick={() => onRevoke(row)}
                            disabled={revokeBusyId === row.id}
                            style={smallDangerButtonStyle}
                          >
                            {revokeBusyId === row.id ? "Revoking..." : "Revoke"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onDelete(row)}
                            disabled={deleteBusyId === row.id}
                            style={smallDangerButtonStyle}
                          >
                            {deleteBusyId === row.id ? "Deleting..." : "Delete"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function HealthTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={healthTileStyle}>
      <p style={healthTileLabelStyle}>{label}</p>
      {children}
    </div>
  );
}

function ComingSoonCard({ def }: { def: IntegrationDefinition }) {
  return (
    <section style={sectionStyle}>
      <div style={{ ...cardStyle, opacity: 0.65 }}>
        <div style={cardHeaderStyle}>
          <div>
            <h3 style={subheadingStyle}>{def.name}</h3>
            <p style={{ ...descriptionStyle, marginBottom: "0.4rem" }}>{def.description}</p>
          </div>
          <span style={mutedBadgeStyle}>
            {def.status === "coming-soon" ? "Coming Soon" : "Future"}
          </span>
        </div>
      </div>
    </section>
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
  margin: "0 0 0.15rem",
  fontSize: "1rem",
  color: "var(--text)"
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

const cardHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "0.75rem",
  flexWrap: "wrap",
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
  padding: "0.55rem 0.75rem",
  background: "var(--brand)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: 600
};

const secondaryButtonStyle: CSSProperties = {
  padding: "0.5rem 0.7rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
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

const disabledButtonStyle: CSSProperties = {
  padding: "0.3rem 0.55rem",
  background: "var(--surface-soft)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "not-allowed",
  fontSize: "0.78rem",
  fontWeight: 600
};

const copyHintStyle: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.68rem",
  color: "var(--text-muted)",
  maxWidth: 150,
  lineHeight: 1.3
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

const notConfiguredBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "var(--surface-soft)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)"
};

const staleBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  fontSize: "0.72rem",
  background: "#fff7e6",
  color: "#7f5a00",
  border: "1px solid #f2d39b"
};

const CONFIG_STATUS_BADGE_STYLE: Record<IntegrationConfigStatus, CSSProperties> = {
  "not-configured": notConfiguredBadgeStyle,
  active: activeBadgeStyle,
  revoked: revokedBadgeStyle
};

const HEALTH_BADGE_STYLE: Record<IntegrationHealthLevel, CSSProperties> = {
  healthy: activeBadgeStyle,
  stale: staleBadgeStyle,
  "never-used": notConfiguredBadgeStyle,
  offline: revokedBadgeStyle
};

const healthSectionStyle: CSSProperties = {
  background: "var(--surface-soft)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "0.75rem",
  marginBottom: "0.9rem"
};

const healthGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  gap: "0.75rem"
};

const healthTileStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem"
};

const healthTileLabelStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.72rem",
  color: "var(--text-muted)",
  fontWeight: 500
};

const healthValueTextStyle: CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 600,
  color: "var(--text)"
};

const mutedBadgeStyle: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "0.1rem 0.5rem",
  fontSize: "0.72rem",
  background: "var(--surface-soft)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  whiteSpace: "nowrap"
};

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000
};

const modalPanelStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "1.5rem",
  maxWidth: 420,
  width: "calc(100% - 2rem)"
};

const modalTitleStyle: CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 600,
  color: "var(--text)",
  margin: "0 0 0.75rem"
};

const modalBodyStyle: CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--text-muted)",
  margin: "0 0 0.4rem"
};

const modalActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.6rem",
  justifyContent: "flex-end",
  marginTop: "1.25rem"
};

const modalDangerButtonStyle: CSSProperties = {
  padding: "0.45rem 0.8rem",
  background: "#c0392b",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.875rem",
  fontWeight: 600
};
