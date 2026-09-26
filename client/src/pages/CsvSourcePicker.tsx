import { useState } from "react";
import { apiFetch } from "../lib/api";

// Source selector for the CSV Template Builder's edit / test workflows:
// upload a file from this computer, or reuse a CSV this organization
// already uploaded (its original text is retained server-side). Recent
// sources are fetched only on an explicit click, never on render.

export type RecentSourceStatus = "imported" | "pending" | "needs_template" | "not_queued";

export type RecentSourceFile = {
  id: string;
  filename: string;
  uploadedAt: string;
  rowCount: number;
  columnCount: number;
  status: RecentSourceStatus;
  templateId: string | null;
  templateName: string | null;
  templateVersion: number | null;
  compatible: boolean | null;
};

export const SOURCE_FILES_URL = "/api/csv-templates/source-files";

const STATUS_LABELS: Record<RecentSourceStatus, string> = {
  imported: "Imported",
  pending: "Pending review",
  needs_template: "Needs a template",
  not_queued: "Not queued"
};

export function formatSourceUploadedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

type Props = {
  /** When set, sources are checked against this template's layout and "most recent compatible" is offered. */
  templateId: string | null;
  busy: boolean;
  onUpload: () => void;
  onSelect: (source: RecentSourceFile) => void | Promise<void>;
};

export function CsvSourcePicker({ templateId, busy, onUpload, onSelect }: Props) {
  const [files, setFiles] = useState<RecentSourceFile[] | null>(null);
  const [showList, setShowList] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function fetchRecent(): Promise<RecentSourceFile[] | null> {
    setLoading(true);
    setMessage(null);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (templateId) params.set("templateId", templateId);
      const res = await apiFetch(`${SOURCE_FILES_URL}?${params.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load recent source files (${res.status})`);
      }
      const body = (await res.json()) as { files: RecentSourceFile[] };
      setFiles(body.files);
      return body.files;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to load recent source files.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleUseMostRecent() {
    const list = files ?? (await fetchRecent());
    if (!list) return;
    const candidate = templateId ? list.find((f) => f.compatible) : list[0];
    if (!candidate) {
      setMessage(
        templateId
          ? "None of the 25 most recent retained sources matches this template's layout. Choose a recent source or upload a CSV."
          : "No retained source files were found. Upload a CSV instead."
      );
      return;
    }
    await onSelect(candidate);
  }

  async function handleChooseRecent() {
    setShowList(true);
    if (!files) await fetchRecent();
  }

  const disabled = busy || loading;

  return (
    <div className="csv-source-picker">
      <div className="csv-source-picker-actions" role="group" aria-label="Choose a source CSV">
        <button type="button" className="csv-tb-btn csv-tb-btn--primary" onClick={onUpload} disabled={disabled} aria-busy={busy || undefined}>
          <UploadIcon />
          Upload CSV
        </button>
        <button type="button" className="csv-tb-btn csv-tb-btn--outline" onClick={() => void handleUseMostRecent()} disabled={disabled}>
          {templateId ? "Use most recent compatible source" : "Use most recent source"}
        </button>
        <button
          type="button"
          className="csv-tb-btn csv-tb-btn--outline"
          onClick={() => void handleChooseRecent()}
          disabled={disabled}
          aria-expanded={showList}
        >
          Choose recent source
        </button>
      </div>
      {loading && (
        <p className="csv-tb-inline-status" role="status">
          Loading recent sources&hellip;
        </p>
      )}
      {message && <p className="form-error">{message}</p>}

      {showList && files && (
        <div className="csv-source-picker-list">
          {files.length === 0 ? (
            <p>No retained source files yet. Files are retained from the next upload onward.</p>
          ) : (
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Uploaded</th>
                  <th>Status</th>
                  <th>Template</th>
                  {templateId && <th>Layout</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <strong>{f.filename}</strong>
                      <div className="csv-source-picker-meta">
                        {f.rowCount} rows &middot; {f.columnCount} columns
                      </div>
                    </td>
                    <td>{formatSourceUploadedAt(f.uploadedAt)}</td>
                    <td>{STATUS_LABELS[f.status]}</td>
                    <td>{f.templateName ? `${f.templateName}${f.templateVersion !== null ? ` v${f.templateVersion}` : ""}` : "—"}</td>
                    {templateId && <td>{f.compatible ? "Matches" : "Different layout"}</td>}
                    <td>
                      <button
                        type="button"
                        className="csv-tb-btn csv-tb-btn--outline csv-tb-btn--sm"
                        onClick={() => void onSelect(f)}
                        disabled={disabled}
                        aria-label={`Use ${f.filename}`}
                      >
                        Use this file
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" className="csv-tb-btn csv-tb-btn--quiet csv-tb-btn--sm" onClick={() => setShowList(false)}>
            Hide list
          </button>
        </div>
      )}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg className="csv-tb-btn-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M10 13V3.5M6 7.5l4-4 4 4M4 13.5v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
