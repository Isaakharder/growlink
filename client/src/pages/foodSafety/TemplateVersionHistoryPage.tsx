import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import { cloneTemplateVersion, getTemplate, getTemplateVersion, listTemplateVersions } from "../../lib/foodSafety/api";
import type { FoodSafetyFormTemplate, FoodSafetyFormTemplateVersionSummary } from "../../lib/foodSafety/types";
import type { FoodSafetyFormSchema } from "../../lib/foodSafety/formSchema";
import { FormPreview } from "../../components/food-safety/FormPreview";

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function shortUser(userId: string | null): string {
  if (!userId) return "-";
  return `${userId.slice(0, 8)}…`;
}

export function FoodSafetyTemplateVersionHistoryPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const { can } = usePermissions();
  const canManage = can("food_safety:manage_templates");

  const [template, setTemplate] = useState<FoodSafetyFormTemplate | null>(null);
  const [versions, setVersions] = useState<FoodSafetyFormTemplateVersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);
  const [previewSchema, setPreviewSchema] = useState<{ versionNumber: number; schema: FoodSafetyFormSchema } | null>(null);

  const load = useCallback(async () => {
    if (!templateId) return;
    setLoading(true);
    setError(null);
    try {
      const [templateRow, versionRows] = await Promise.all([getTemplate(templateId), listTemplateVersions(templateId)]);
      setTemplate(templateRow);
      setVersions(versionRows.sort((a, b) => b.version_number - a.version_number));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load version history.");
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasDraft = versions.some((v) => v.status === "draft");

  async function preview(versionId: string, versionNumber: number) {
    if (!templateId) return;
    setError(null);
    try {
      const full = await getTemplateVersion(templateId, versionId);
      setPreviewSchema({ versionNumber, schema: full.schema_json });
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Failed to load version for preview.");
    }
  }

  async function createNewVersion(versionId: string) {
    if (!templateId) return;
    setError(null);
    setBusyVersionId(versionId);
    try {
      await cloneTemplateVersion(templateId, versionId);
      await load();
    } catch (cloneError) {
      setError(cloneError instanceof Error ? cloneError.message : "Failed to create a new version.");
    } finally {
      setBusyVersionId(null);
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Version History{template ? ` — ${template.name}` : ""}</h1>
        <p>
          <Link to="/food-safety/templates">Form Templates</Link>
          {template ? (
            <>
              {" "}
              · <Link to={`/food-safety/templates/${templateId}/edit`}>Open Editor</Link>
            </>
          ) : null}
        </p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        {loading ? <p>Loading...</p> : null}
        {!loading && versions.length === 0 ? <p>No versions yet.</p> : null}

        {!loading && versions.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Published</th>
                  <th>Notes</th>
                  <th>Created By</th>
                  <th>Published By</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td>v{version.version_number}</td>
                    <td>
                      <span
                        className={version.status === "published" ? "status-badge active" : "status-badge inactive"}
                      >
                        {version.status === "published" ? "Published (read-only)" : "Draft"}
                      </span>
                    </td>
                    <td>{formatDate(version.created_at)}</td>
                    <td>{formatDate(version.published_at)}</td>
                    <td>{version.version_notes ?? "-"}</td>
                    <td>{shortUser(version.created_by_user_id)}</td>
                    <td>{shortUser(version.published_by_user_id)}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => void preview(version.id, version.version_number)}>
                          Preview
                        </button>
                        {canManage && version.status === "published" && !hasDraft ? (
                          <button
                            type="button"
                            onClick={() => void createNewVersion(version.id)}
                            disabled={busyVersionId === version.id}
                          >
                            {busyVersionId === version.id ? "Creating..." : "Create New Version"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {previewSchema ? (
        <div className="modal-overlay" onClick={() => setPreviewSchema(null)}>
          <div className="variety-modal" style={{ maxWidth: 720, width: "calc(100% - 2rem)" }} onClick={(event) => event.stopPropagation()}>
            <div className="row-actions" style={{ justifyContent: "flex-end", marginBottom: "0.5rem" }}>
              <button type="button" className="secondary" onClick={() => setPreviewSchema(null)}>
                Close
              </button>
            </div>
            <p style={{ fontWeight: 600 }}>Previewing version {previewSchema.versionNumber}</p>
            <FormPreview schema={previewSchema.schema} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
