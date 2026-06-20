import { FormEvent, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type YieldSize = { id: string; name: string };

type KeyInfo = {
  id: string;
  label: string;
  dataSourceType: string;
  status: string;
  organizationId: string;
  organizationName: string;
};

type ExistingTemplate = {
  id: string;
  name: string;
  column_mappings: ColumnMappings;
};

type ColumnMappings = {
  unique_key_column: string;
  date_column?: string | null;
  variety_column?: string | null;
  kg_total_column?: string | null;
  size_columns?: Record<string, string>;
};

type CsvPreview = {
  headers: string[];
  rows: string[][];
};

type PageData = {
  key: KeyInfo;
  template: ExistingTemplate | null;
  csvPreview: CsvPreview | null;
  previewFilename: string | null;
  yieldSizes: YieldSize[];
  needsTemplateCount: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const NONE = "" as const;

function getResponseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const m = (body as { message?: unknown }).message;
  return typeof m === "string" && m.trim() ? m : fallback;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImportTemplateMappingPage() {
  const { uploadKeyId } = useParams<{ uploadKeyId: string }>();
  const navigate = useNavigate();

  const [pageData, setPageData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [uniqueKeyCol, setUniqueKeyCol] = useState<string>(NONE);
  const [dateCol, setDateCol] = useState<string>(NONE);
  const [varietyCol, setVarietyCol] = useState<string>(NONE);
  const [totalKgCol, setTotalKgCol] = useState<string>(NONE);
  const [sizeColMap, setSizeColMap] = useState<Record<string, string>>({});
  const [templateName, setTemplateName] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // ── Load ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!uploadKeyId) return;
    void load();
  }, [uploadKeyId]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/admin/import-templates/by-key/${uploadKeyId}`);
      const body = (await res.json().catch(() => ({}))) as Partial<PageData> & { message?: string };
      if (!res.ok) {
        setLoadError(getResponseMessage(body, "Failed to load template data."));
        return;
      }
      const data = body as PageData;
      setPageData(data);

      const cm = data.template?.column_mappings;
      if (cm) {
        setTemplateName(data.template?.name ?? "");
        setUniqueKeyCol(cm.unique_key_column ?? NONE);
        setDateCol(cm.date_column ?? NONE);
        setVarietyCol(cm.variety_column ?? NONE);
        setTotalKgCol(cm.kg_total_column ?? NONE);
        setSizeColMap(cm.size_columns ?? {});
      } else {
        setTemplateName(`${data.key.label} Import`);
      }
    } catch {
      setLoadError("Network error while loading template data.");
    } finally {
      setLoading(false);
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────

  const headers = useMemo(() => pageData?.csvPreview?.headers ?? [], [pageData]);

  const headerOptions = useMemo(
    () => [{ value: NONE, label: "— not mapped —" }, ...headers.map((h) => ({ value: h, label: h }))],
    [headers]
  );

  const canSave = uniqueKeyCol !== NONE && templateName.trim().length > 0;

  // ── Save ────────────────────────────────────────────────────────────────────

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!canSave || !uploadKeyId) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const cleanedSizeColumns: Record<string, string> = {};
    for (const [sizeName, colName] of Object.entries(sizeColMap)) {
      if (colName && colName !== NONE) cleanedSizeColumns[sizeName] = colName;
    }

    const columnMappings: ColumnMappings = {
      unique_key_column: uniqueKeyCol,
      date_column: dateCol || null,
      variety_column: varietyCol || null,
      kg_total_column: totalKgCol || null,
      size_columns: Object.keys(cleanedSizeColumns).length > 0 ? cleanedSizeColumns : undefined,
    };

    try {
      const res = await apiFetch(`/api/admin/import-templates/by-key/${uploadKeyId}`, {
        method: "POST",
        body: JSON.stringify({ name: templateName.trim(), columnMappings }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError(getResponseMessage(body, "Failed to save template."));
        return;
      }
      setSaveSuccess(true);
      await load();
    } catch {
      setSaveError("Network error while saving template.");
    } finally {
      setSaving(false);
    }
  }

  // ── Apply ───────────────────────────────────────────────────────────────────

  async function handleApply() {
    if (!uploadKeyId) return;
    setApplying(true);
    setApplyResult(null);
    setApplyError(null);

    try {
      const res = await apiFetch(`/api/admin/import-templates/by-key/${uploadKeyId}/apply`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        applied?: number;
        skipped?: number;
        failed?: number;
      };
      if (!res.ok) {
        setApplyError(getResponseMessage(body, "Failed to apply template."));
        return;
      }
      setApplyResult(
        `Applied: ${body.applied ?? 0}  Skipped: ${body.skipped ?? 0}  Failed: ${body.failed ?? 0}`
      );
      await load();
    } catch {
      setApplyError("Network error while applying template.");
    } finally {
      setApplying(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return <div style={shellStyle}><p style={mutedStyle}>Loading…</p></div>;
  }

  if (loadError || !pageData) {
    return (
      <div style={shellStyle}>
        <p style={errorStyle}>{loadError ?? "Unknown error."}</p>
        <button style={secondaryBtn} onClick={() => navigate(-1)}>Back</button>
      </div>
    );
  }

  const { key, csvPreview, previewFilename, yieldSizes, needsTemplateCount } = pageData;

  return (
    <div style={shellStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
        <button style={backBtn} onClick={() => navigate("/admin/growlink-agent")}>← Back</button>
        <h1 style={h1Style}>Configure Import: {key.label}</h1>
      </div>
      <p style={mutedStyle}>
        {key.organizationName} · Generic CSV · {key.status}
      </p>

      {needsTemplateCount > 0 && !saveSuccess && (
        <p style={warnBanner}>
          {needsTemplateCount} file{needsTemplateCount !== 1 ? "s" : ""} waiting — save the mapping below then click Apply.
        </p>
      )}

      {/* CSV Preview */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>CSV Preview{previewFilename ? ` — ${previewFilename}` : ""}</h2>
        {csvPreview && csvPreview.headers.length > 0 ? (
          <>
            <p style={mutedStyle}>First {csvPreview.rows.length} data rows. Use the column headers to set up the mapping below.</p>
            <div style={{ overflowX: "auto", maxHeight: 260, overflowY: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    {csvPreview.headers.map((h) => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvPreview.rows.map((row, ri) => (
                    <tr key={ri}>
                      {csvPreview.headers.map((_, ci) => (
                        <td key={ci} style={tdStyle}>{row[ci] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p style={mutedStyle}>No CSV preview yet. Upload a file from Computer B first, then return here to configure the mapping.</p>
        )}
      </section>

      {/* Mapping Form */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Column Mapping</h2>
        <p style={mutedStyle}>
          Assign CSV columns to GrowLink fields. Only <strong>Unique Key</strong> is required.
          Unassigned fields are ignored during import.
        </p>

        <form onSubmit={handleSave}>
          <div style={formGrid}>
            <div style={fieldRow}>
              <label style={labelStyle}>Template name <span style={reqStar}>*</span></label>
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g. Packline B Export"
                style={inputStyle}
              />
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>
                Unique Key <span style={reqStar}>*</span>
                <span style={fieldHint}> — identifies each record (e.g. lot number, batch ID)</span>
              </label>
              <ColSelect value={uniqueKeyCol} options={headerOptions} onChange={setUniqueKeyCol} />
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>
                Date
                <span style={fieldHint}> — used to calculate ISO year and week</span>
              </label>
              <ColSelect value={dateCol} options={headerOptions} onChange={setDateCol} />
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>Variety</label>
              <ColSelect value={varietyCol} options={headerOptions} onChange={setVarietyCol} />
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>Total KG</label>
              <ColSelect value={totalKgCol} options={headerOptions} onChange={setTotalKgCol} />
            </div>

            {yieldSizes.length > 0 && (
              <>
                <div style={{ ...fieldRow, borderTop: "1px solid var(--border)", paddingTop: "0.75rem", marginTop: "0.25rem" }}>
                  <p style={{ ...labelStyle, fontWeight: 600, marginBottom: 0 }}>Size KG columns</p>
                  <p style={mutedStyle}>Map each active yield size to its CSV column.</p>
                </div>
                {yieldSizes.map((size) => (
                  <div key={size.id} style={fieldRow}>
                    <label style={labelStyle}>KG — {size.name}</label>
                    <ColSelect
                      value={sizeColMap[size.name] ?? NONE}
                      options={headerOptions}
                      onChange={(val) => setSizeColMap((prev) => ({ ...prev, [size.name]: val }))}
                    />
                  </div>
                ))}
              </>
            )}
          </div>

          {saveError && <p style={errorStyle}>{saveError}</p>}
          {saveSuccess && <p style={successStyle}>Template saved.</p>}

          <div style={{ display: "flex", gap: "0.6rem", marginTop: "1rem", flexWrap: "wrap" }}>
            <button type="submit" disabled={!canSave || saving} style={primaryBtn}>
              {saving ? "Saving…" : pageData.template ? "Update template" : "Save template"}
            </button>
            {pageData.template && needsTemplateCount > 0 && (
              <button type="button" disabled={applying} onClick={handleApply} style={secondaryBtn}>
                {applying
                  ? "Applying…"
                  : `Apply to ${needsTemplateCount} pending file${needsTemplateCount !== 1 ? "s" : ""}`}
              </button>
            )}
          </div>

          {applyError && <p style={errorStyle}>{applyError}</p>}
          {applyResult && <p style={successStyle}>{applyResult}</p>}
        </form>
      </section>
    </div>
  );
}

// ── ColSelect ─────────────────────────────────────────────────────────────────

function ColSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const shellStyle: CSSProperties = {
  maxWidth: 900,
  margin: "0 auto",
  padding: "1.5rem 1rem 3rem",
};

const h1Style: CSSProperties = {
  fontSize: "1.2rem",
  fontWeight: 600,
  margin: 0,
  color: "var(--text)",
};

const h2Style: CSSProperties = {
  fontSize: "1rem",
  fontWeight: 600,
  margin: "0 0 0.4rem",
  color: "var(--text)",
};

const sectionStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "1rem",
  marginTop: "1rem",
};

const mutedStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "0.85rem",
  margin: "0 0 0.5rem",
};

const errorStyle: CSSProperties = {
  color: "#c0392b",
  background: "#fdf2f2",
  border: "1px solid #f5c6c6",
  borderRadius: 6,
  padding: "0.5rem 0.65rem",
  fontSize: "0.82rem",
  margin: "0.5rem 0 0",
};

const successStyle: CSSProperties = {
  color: "#1f7a42",
  background: "#e8f8ef",
  border: "1px solid #bfe9cf",
  borderRadius: 6,
  padding: "0.5rem 0.65rem",
  fontSize: "0.82rem",
  margin: "0.5rem 0 0",
};

const warnBanner: CSSProperties = {
  background: "#fff7e6",
  border: "1px solid #f2d39b",
  borderRadius: 6,
  padding: "0.55rem 0.7rem",
  fontSize: "0.82rem",
  color: "#7f5a00",
  margin: "0.75rem 0 0",
};

const tableStyle: CSSProperties = {
  borderCollapse: "collapse",
  fontSize: "0.78rem",
  whiteSpace: "nowrap",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.3rem 0.5rem",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-muted)",
  fontWeight: 600,
  background: "var(--surface-soft)",
  position: "sticky",
  top: 0,
};

const tdStyle: CSSProperties = {
  padding: "0.25rem 0.5rem",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  maxWidth: 180,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const formGrid: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.65rem" };
const fieldRow: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.25rem" };

const labelStyle: CSSProperties = {
  fontSize: "0.82rem",
  fontWeight: 500,
  color: "var(--text)",
};

const fieldHint: CSSProperties = {
  fontWeight: 400,
  color: "var(--text-muted)",
};

const reqStar: CSSProperties = { color: "#c0392b" };

const inputStyle: CSSProperties = {
  padding: "0.42rem 0.6rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.88rem",
  color: "var(--text)",
  background: "var(--surface-soft)",
  maxWidth: 360,
};

const selectStyle: CSSProperties = {
  padding: "0.42rem 0.6rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.88rem",
  color: "var(--text)",
  background: "var(--surface-soft)",
  maxWidth: 360,
};

const primaryBtn: CSSProperties = {
  padding: "0.5rem 0.9rem",
  background: "var(--brand)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.88rem",
  fontWeight: 600,
};

const secondaryBtn: CSSProperties = {
  padding: "0.5rem 0.9rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.88rem",
};

const backBtn: CSSProperties = {
  padding: "0.3rem 0.6rem",
  background: "transparent",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.8rem",
};
