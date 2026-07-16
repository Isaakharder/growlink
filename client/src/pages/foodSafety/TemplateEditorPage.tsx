import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import {
  cloneTemplateVersion,
  createFirstTemplateVersion,
  getTemplate,
  getTemplateVersion,
  listDepartments,
  listTemplateVersions,
  publishTemplateVersion,
  updateTemplate,
  updateTemplateVersionDraft
} from "../../lib/foodSafety/api";
import type { FoodSafetyDepartment, FoodSafetyFormTemplate, FoodSafetyFormTemplateVersionSummary } from "../../lib/foodSafety/types";
import {
  createEmptySchema,
  createEmptySection,
  readRequiresVerification,
  type FoodSafetyFormSchema,
  type FoodSafetyFormSection
} from "../../lib/foodSafety/formSchema";
import { SectionEditor } from "../../components/food-safety/SectionEditor";
import { FormPreview } from "../../components/food-safety/FormPreview";

type Phase = "loading" | "no-versions" | "editing-draft" | "published-only" | "error";

export function FoodSafetyTemplateEditorPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const { can } = usePermissions();
  const canManage = can("food_safety:manage_templates");

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [template, setTemplate] = useState<FoodSafetyFormTemplate | null>(null);
  const [departments, setDepartments] = useState<FoodSafetyDepartment[]>([]);
  const [versions, setVersions] = useState<FoodSafetyFormTemplateVersionSummary[]>([]);

  const [draftVersionId, setDraftVersionId] = useState<string | null>(null);
  const [versionNumber, setVersionNumber] = useState<number | null>(null);
  const [schema, setSchema] = useState<FoodSafetyFormSchema | null>(null);
  const [versionNotes, setVersionNotes] = useState("");

  const [publishedPreviewSchema, setPublishedPreviewSchema] = useState<FoodSafetyFormSchema | null>(null);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    if (!templateId) return;
    setPhase("loading");
    setError(null);

    try {
      const [templateRow, departmentRows, versionRows] = await Promise.all([
        getTemplate(templateId),
        listDepartments(),
        listTemplateVersions(templateId)
      ]);
      setTemplate(templateRow);
      setDepartments(departmentRows);
      setVersions(versionRows);

      const draft = versionRows.find((v) => v.status === "draft");
      if (draft) {
        const full = await getTemplateVersion(templateId, draft.id);
        setDraftVersionId(full.id);
        setVersionNumber(full.version_number);
        setSchema(full.schema_json);
        setVersionNotes(full.version_notes ?? "");
        setPhase("editing-draft");
        return;
      }

      const latestPublished = versionRows
        .filter((v) => v.status === "published")
        .sort((a, b) => b.version_number - a.version_number)[0];

      if (latestPublished) {
        const full = await getTemplateVersion(templateId, latestPublished.id);
        setPublishedPreviewSchema(full.schema_json);
        setPhase("published-only");
        return;
      }

      setSchema(createEmptySchema(templateRow.name));
      setDraftVersionId(null);
      setVersionNumber(null);
      setVersionNotes("");
      setPhase("no-versions");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the form template.");
      setPhase("error");
    }
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalFieldCount = useMemo(
    () => (schema ? schema.sections.reduce((count, section) => count + section.fields.length, 0) : 0),
    [schema]
  );

  function addSection() {
    if (!schema) return;
    setSchema({ ...schema, sections: [...schema.sections, createEmptySection(schema.sections.length)] });
  }

  function updateSection(index: number, next: FoodSafetyFormSection) {
    if (!schema) return;
    setSchema({ ...schema, sections: schema.sections.map((s, i) => (i === index ? next : s)) });
  }

  function removeSection(index: number) {
    if (!schema) return;
    setSchema({ ...schema, sections: schema.sections.filter((_, i) => i !== index) });
  }

  function moveSection(index: number, direction: -1 | 1) {
    if (!schema) return;
    const target = index + direction;
    if (target < 0 || target >= schema.sections.length) return;
    const sections = [...schema.sections];
    [sections[index], sections[target]] = [sections[target], sections[index]];
    setSchema({ ...schema, sections: sections.map((s, i) => ({ ...s, sortOrder: i })) });
  }

  async function saveDraft() {
    if (!templateId || !schema) return;
    setError(null);

    if (!schema.title.trim()) {
      setError("Title is required before saving.");
      return;
    }
    if (schema.sections.length === 0 || totalFieldCount === 0) {
      setError("Add at least one section with at least one field before saving.");
      return;
    }

    setSaving(true);
    try {
      if (draftVersionId) {
        const updated = await updateTemplateVersionDraft(templateId, draftVersionId, schema, versionNotes || null);
        setVersionNumber(updated.version_number);
      } else {
        const created = await createFirstTemplateVersion(templateId, schema, versionNotes || null);
        setDraftVersionId(created.id);
        setVersionNumber(created.version_number);
        await load(); // refresh version history summary
        return;
      }
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save draft.");
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    if (!templateId || !draftVersionId) return;
    setError(null);
    setSaving(true);
    try {
      await publishTemplateVersion(templateId, draftVersionId);
      setPublishConfirmOpen(false);
      await load();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Failed to publish version.");
    } finally {
      setSaving(false);
    }
  }

  async function createNewVersionFromPublished() {
    if (!templateId) return;
    const latestPublished = versions.filter((v) => v.status === "published").sort((a, b) => b.version_number - a.version_number)[0];
    if (!latestPublished) return;

    setError(null);
    setSaving(true);
    try {
      await cloneTemplateVersion(templateId, latestPublished.id);
      await load();
    } catch (cloneError) {
      setError(cloneError instanceof Error ? cloneError.message : "Failed to create a new version.");
    } finally {
      setSaving(false);
    }
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!templateId || !template) return;
    setError(null);
    try {
      const updated = await updateTemplate(templateId, {
        name: template.name,
        description: template.description,
        department_id: template.department_id,
        form_code: template.form_code,
        canadagap_section: template.canadagap_section,
        instructions: template.instructions,
        active: template.active
      });
      setTemplate(updated);
    } catch (metaError) {
      setError(metaError instanceof Error ? metaError.message : "Failed to save template metadata.");
    }
  }

  if (phase === "loading") {
    return (
      <section className="page-shell">
        <p>Loading...</p>
      </section>
    );
  }

  if (phase === "error" || !template) {
    return (
      <section className="page-shell">
        <p className="form-error">{error ?? "Form template not found."}</p>
        <Link to="/food-safety/templates">Back to Form Templates</Link>
      </section>
    );
  }

  return (
    <section className="page-shell">
      <header>
        <h1>{template.name}</h1>
        <p>
          <Link to="/food-safety/templates">Form Templates</Link> ·{" "}
          <Link to={`/food-safety/templates/${templateId}/versions`}>Version History</Link>
        </p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      {canManage ? (
        <div className="coming-soon-card">
          <h2>Template Metadata</h2>
          <form className="varieties-form" onSubmit={saveMetadata}>
            <label>
              Name
              <input
                type="text"
                value={template.name}
                onChange={(event) => setTemplate({ ...template, name: event.target.value })}
              />
            </label>
            <label>
              Department
              <select
                value={template.department_id ?? ""}
                onChange={(event) => setTemplate({ ...template, department_id: event.target.value || null })}
              >
                <option value="">No department</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Form code
              <input
                type="text"
                value={template.form_code ?? ""}
                onChange={(event) => setTemplate({ ...template, form_code: event.target.value || null })}
              />
            </label>
            <label>
              CanadaGAP section
              <input
                type="text"
                value={template.canadagap_section ?? ""}
                onChange={(event) => setTemplate({ ...template, canadagap_section: event.target.value || null })}
              />
            </label>
            <div className="form-actions">
              <button type="submit">Save Metadata</button>
            </div>
          </form>
        </div>
      ) : null}

      {phase === "published-only" && publishedPreviewSchema ? (
        <>
          <div className="coming-soon-card">
            <span className="status-badge active">Published — read-only</span>
            <p>
              This template has no draft in progress. To make changes, create a new version — it will start as a copy
              of the latest published version.
            </p>
            {canManage ? (
              <button type="button" onClick={() => void createNewVersionFromPublished()} disabled={saving}>
                {saving ? "Creating..." : "Create New Version"}
              </button>
            ) : null}
          </div>
          <FormPreview schema={publishedPreviewSchema} />
        </>
      ) : null}

      {phase === "no-versions" && !canManage ? (
        <div className="coming-soon-card">
          <p>
            This template has no version yet. Only Food Safety template managers can create the first version.
          </p>
        </div>
      ) : null}

      {phase === "editing-draft" && !canManage && schema ? (
        <>
          <div className="coming-soon-card">
            <span className="status-badge inactive">
              Draft{versionNumber != null ? ` v${versionNumber}` : ""} — read-only preview
            </span>
            <p>You have view-only access to Food Safety templates and cannot edit this draft.</p>
          </div>
          <FormPreview schema={schema} />
        </>
      ) : null}

      {(phase === "editing-draft" || phase === "no-versions") && canManage && schema ? (
        <>
          <div className="coming-soon-card">
            <span className="status-badge inactive">
              Draft{versionNumber != null ? ` v${versionNumber}` : ""} — editable
            </span>
            <div className="varieties-form" style={{ marginTop: "0.6rem" }}>
              <label>
                Form title
                <input type="text" value={schema.title} onChange={(event) => setSchema({ ...schema, title: event.target.value })} />
              </label>
              <label>
                Form description
                <input
                  type="text"
                  value={schema.description ?? ""}
                  onChange={(event) => setSchema({ ...schema, description: event.target.value })}
                />
              </label>
              <label>
                Instructions
                <textarea
                  rows={2}
                  value={schema.instructions ?? ""}
                  onChange={(event) => setSchema({ ...schema, instructions: event.target.value })}
                />
              </label>
              <label>
                Version notes
                <input type="text" value={versionNotes} onChange={(event) => setVersionNotes(event.target.value)} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={readRequiresVerification(schema)}
                  onChange={(event) =>
                    setSchema({ ...schema, workflow: { requiresVerification: event.target.checked } })
                  }
                />
                Requires supervisor verification before a submitted record is considered complete
              </label>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "1rem", alignItems: "start" }}>
            <div>
              {schema.sections.map((section, index) => (
                <SectionEditor
                  key={section.id}
                  section={section}
                  departments={departments}
                  canMoveUp={index > 0}
                  canMoveDown={index < schema.sections.length - 1}
                  onChange={(next) => updateSection(index, next)}
                  onRemove={() => removeSection(index)}
                  onMoveUp={() => moveSection(index, -1)}
                  onMoveDown={() => moveSection(index, 1)}
                />
              ))}
              <button type="button" onClick={addSection}>
                + Add Section
              </button>

              <div className="form-actions" style={{ marginTop: "1rem" }}>
                <button type="button" onClick={() => void saveDraft()} disabled={saving}>
                  {saving ? "Saving..." : "Save Draft"}
                </button>
                {draftVersionId ? (
                  <button type="button" onClick={() => setPublishConfirmOpen(true)} disabled={saving}>
                    Publish
                  </button>
                ) : null}
              </div>
            </div>

            <div>
              <h3>Live Preview</h3>
              <FormPreview schema={schema} />
            </div>
          </div>
        </>
      ) : null}

      {publishConfirmOpen ? (
        <div className="modal-overlay" onClick={() => setPublishConfirmOpen(false)}>
          <div className="variety-modal" onClick={(event) => event.stopPropagation()}>
            <h2>Publish this version?</h2>
            <p>
              Once published, version {versionNumber} becomes permanent and read-only. To make further changes
              afterward, you will need to create a new version.
            </p>
            <div className="form-actions">
              <button type="button" onClick={() => void publish()} disabled={saving}>
                {saving ? "Publishing..." : "Publish"}
              </button>
              <button type="button" className="secondary" onClick={() => setPublishConfirmOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
