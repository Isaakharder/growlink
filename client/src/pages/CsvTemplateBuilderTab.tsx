import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

// ---------------------------------------------------------------------------
// Types mirroring server/src/utils/csvTemplateTypes.ts (kept independent —
// this is API response shape, not a shared import across the client/server
// boundary).
// ---------------------------------------------------------------------------

const MAPPED_FIELDS = [
  "variety", "packed_date", "year", "week", "lot_number", "run_number",
  "market_grade", "size_label", "size_weight_kg", "average_fruit_weight_g",
  "piece_count", "waste_kg", "total_lot_weight", "ignore", "custom"
] as const;
type MappedField = (typeof MAPPED_FIELDS)[number];

const FIELD_LABELS: Record<MappedField, string> = {
  variety: "Variety",
  packed_date: "Packed Date",
  year: "Year",
  week: "Week",
  lot_number: "Lot Number",
  run_number: "Run Number",
  market_grade: "Market/Grade",
  size_label: "Size Label",
  size_weight_kg: "Size Weight kg",
  average_fruit_weight_g: "Average Fruit Weight g",
  piece_count: "Piece Count",
  waste_kg: "Waste kg",
  total_lot_weight: "Total Lot Weight",
  ignore: "Ignore",
  custom: "Custom/unused field"
};

const DATE_FORMATS = ["DDMMYYYY", "YYYYMMDD", "MMDDYYYY", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "CUSTOM"] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

type ColumnMapping = {
  columnIndex: number;
  field: MappedField;
  dateFormat?: DateFormat;
  customDatePattern?: string;
  numberFormat?: NumberFormatConfig;
};

type FixedCellMapping = {
  rowIndex: number;
  columnIndex: number;
  field: MappedField;
  dateFormat?: DateFormat;
  customDatePattern?: string;
  numberFormat?: NumberFormatConfig;
};

type NumberFormatConfig = {
  decimalSeparator: "." | ",";
  thousandsSeparator: "" | "," | "." | " ";
  unitConversionFactor?: number;
  blankHandling: "zero" | "skip" | "error";
};

type ValueMappingAction = "map" | "create" | "ignore" | "distribute" | "subtotal" | "use_other_field" | "unresolved";

type ValueMapping = {
  sourceField: "size_label" | "market_grade";
  rawValue: string;
  action: ValueMappingAction;
  targetSizeId?: string;
  newSizeName?: string;
  distributeSizeIds?: string[];
};

type RuleOperator = "equals" | "not_equals" | "contains" | "is_blank" | "is_not_blank";
type RuleCondition = { field: MappedField; operator: RuleOperator; value?: string };
type RuleAction = "map_to_size" | "ignore" | "distribute" | "treat_as_subtotal";
type ConditionalRowRule = {
  id: string;
  priority: number;
  conditions: RuleCondition[];
  conditionLogic: "AND" | "OR";
  action: RuleAction;
  targetSizeId?: string;
  distributeSizeIds?: string[];
};

type DraftConfig = {
  delimiter: string;
  headerRowIndex: number;
  dataStartRowIndex: number;
  dataEndRowIndex: number | null;
  skipRowIndexes: number[];
  blankRowBehavior: "skip" | "stop";
  columnMappings: ColumnMapping[];
  fixedCellMappings: FixedCellMapping[];
  valueMappings: ValueMapping[];
  rules: ConditionalRowRule[];
};

type ParseGridResponse = {
  sourceFileId: string;
  grid: string[][];
  rowCount: number;
  columnCount: number;
  delimiter: string;
  encoding: string;
  match: { kind: "exact" | "close" | "none"; templateId: string | null; templateName: string | null; similarity: number | null };
};

type NormalizedRow = {
  rowIndex: number;
  action: "included" | "ignored" | "subtotal" | "unresolved";
  sizeLabelRaw: string | null;
  marketGradeRaw: string | null;
  sizeWeightKg: number | null;
};

type NormalizedGroup = {
  groupKey: string;
  varietyRaw: string | null;
  packedDate: string | null;
  isoYear: number | null;
  isoWeek: number | null;
  lotNumber: string | null;
  sizeKg: Record<string, number>;
  unresolvedSizeLabels: string[];
  wasteKg: number;
  pieceCount: number;
  averageFruitWeightG: number | null;
  totalLotWeightKg: number | null;
  reconciliation: {
    rawRowWeightKg: number;
    recognizedSizeKg: number;
    directMappedKg: number;
    distributedKg: number;
    ignoredKg: number;
    unresolvedKg: number;
    subtotalKg: number;
    lotTotalKg: number | null;
    difference: number | null;
    unexplainedDifference: boolean;
  };
  rows: NormalizedRow[];
};

type ValidationIssue = { code: string; message: string; groupKey?: string; rowIndex?: number };

type NormalizedPreview = { groups: NormalizedGroup[]; validationIssues: ValidationIssue[]; canImport: boolean };

type PreviewResponse = { preview: NormalizedPreview; templateId: string | null; templateVersion: number | null; layoutMismatch: boolean };

type PendingCsvItem = {
  id: string;
  sourceFilename: string;
  sourceFileId: string | null;
  uploadedAt: string;
  needsTemplate: boolean;
  templateId: string | null;
  templateName: string | null;
  templateVersion: number | null;
  matchKind: "close" | "none" | null;
  preview: NormalizedPreview | null;
  error: string | null;
};

type SourceFileGridResponse = {
  sourceFileId: string;
  filename: string;
  grid: string[][];
  rowCount: number;
  columnCount: number;
  delimiter: string;
  match: { kind: "exact" | "close" | "none"; templateId: string | null; templateName: string | null; similarity: number | null };
};

type YieldSizeOption = { id: string; name: string };

const PARSE_GRID_URL = "/api/csv-templates/parse-grid";
const PREVIEW_URL = "/api/csv-templates/preview";
const TEMPLATES_URL = "/api/csv-templates";
const IMPORT_URL = "/api/csv-templates/import";
const YIELD_SIZES_URL = "/api/yield-sizes";
const PENDING_URL = "/api/csv-templates/pending";
const sourceFileGridUrl = (id: string) => `/api/csv-templates/source-files/${id}/grid`;

function emptyDraft(): DraftConfig {
  return {
    delimiter: ",",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    dataEndRowIndex: null,
    skipRowIndexes: [],
    blankRowBehavior: "skip",
    columnMappings: [],
    fixedCellMappings: [],
    valueMappings: [],
    rules: []
  };
}

function columnLetter(index: number): string {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

export function CsvTemplateBuilderTab() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseGridResponse | null>(null);
  const [closeMatchChoice, setCloseMatchChoice] = useState<"pending" | "use" | "build">("pending");
  const [draft, setDraft] = useState<DraftConfig>(emptyDraft());
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [yieldSizes, setYieldSizes] = useState<YieldSizeOption[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<Record<string, string>>({});
  const [pendingItems, setPendingItems] = useState<PendingCsvItem[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [resumingPendingId, setResumingPendingId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch(YIELD_SIZES_URL);
      if (!res.ok) return;
      const body = (await res.json()) as YieldSizeOption[];
      setYieldSizes(body);
    })();
    void fetchPendingItems();
  }, []);

  async function fetchPendingItems() {
    setPendingLoading(true);
    setPendingError(null);
    try {
      const res = await apiFetch(PENDING_URL);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load pending CSV imports (${res.status})`);
      }
      const body = (await res.json()) as { files: PendingCsvItem[] };
      setPendingItems(body.files);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : "Failed to load pending CSV imports.");
    } finally {
      setPendingLoading(false);
    }
  }

  // "Set up CSV Template" — resumes the grid builder from an already-uploaded
  // pending file's preserved raw text, without requiring a re-upload.
  async function handleSetUpTemplateFromPending(item: PendingCsvItem) {
    if (!item.sourceFileId) return;
    setResumingPendingId(item.id);
    setUploadError(null);
    try {
      const res = await apiFetch(sourceFileGridUrl(item.sourceFileId));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load source file (${res.status})`);
      }
      const body = (await res.json()) as SourceFileGridResponse;

      setPreview(null);
      setActiveTemplateId(null);
      setCloseMatchChoice(body.match.kind === "close" ? "pending" : "build");
      setTemplateName(body.filename.replace(/\.csv$/i, ""));
      setDraft((current) => ({ ...emptyDraft(), delimiter: body.delimiter, headerRowIndex: 0, dataStartRowIndex: 1, valueMappings: current.valueMappings }));
      setParsed({
        sourceFileId: body.sourceFileId,
        grid: body.grid,
        rowCount: body.rowCount,
        columnCount: body.columnCount,
        delimiter: body.delimiter,
        encoding: "utf-8",
        match: body.match
      });

      if (body.match.kind === "exact" && body.match.templateId) {
        setActiveTemplateId(body.match.templateId);
        await fetchPreviewForTemplate(body.sourceFileId, body.match.templateId);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to resume this file in the builder.");
    } finally {
      setResumingPendingId(null);
    }
  }

  async function handleImportPendingGroup(item: PendingCsvItem, group: NormalizedGroup) {
    if (!item.sourceFileId || !item.templateId) return;
    setImportingKey(group.groupKey);
    setImportStatus((current) => ({ ...current, [group.groupKey]: "" }));
    try {
      const res = await apiFetch(IMPORT_URL, {
        method: "POST",
        body: JSON.stringify({
          sourceFileId: item.sourceFileId,
          templateId: item.templateId,
          groupKey: group.groupKey,
          approvedGroup: group
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Import failed (${res.status})`);
      }
      const body = (await res.json()) as { mode: "create" | "append" };
      setImportStatus((current) => ({ ...current, [group.groupKey]: `Imported (${body.mode}).` }));
      void fetchPendingItems();
    } catch (err) {
      setImportStatus((current) => ({
        ...current,
        [group.groupKey]: err instanceof Error ? err.message : "Import failed."
      }));
    } finally {
      setImportingKey(null);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    setUploading(true);
    setParsed(null);
    setPreview(null);
    setActiveTemplateId(null);
    setCloseMatchChoice("pending");
    setDraft(emptyDraft());
    setTemplateName(file.name.replace(/\.csv$/i, ""));

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await apiFetch(PARSE_GRID_URL, { method: "POST", body: formData });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Upload failed (${res.status})`);
      }
      const body = (await res.json()) as ParseGridResponse;
      setParsed(body);
      setDraft((current) => ({ ...current, delimiter: body.delimiter }));

      if (body.match.kind === "exact" && body.match.templateId) {
        setActiveTemplateId(body.match.templateId);
        await fetchPreviewForTemplate(body.sourceFileId, body.match.templateId);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to upload CSV file.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function fetchPreviewForTemplate(sourceFileId: string, templateId: string) {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await apiFetch(PREVIEW_URL, {
        method: "POST",
        body: JSON.stringify({ sourceFileId, templateId })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Preview failed (${res.status})`);
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to build preview.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function fetchPreviewForDraft(sourceFileId: string, draftConfig: DraftConfig) {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await apiFetch(PREVIEW_URL, {
        method: "POST",
        body: JSON.stringify({ sourceFileId, draftConfig })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Preview failed (${res.status})`);
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to build preview.");
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  const isBuildingDraft = parsed !== null && (parsed.match.kind === "none" || (parsed.match.kind === "close" && closeMatchChoice === "build"));

  // Debounced live preview whenever the draft mapping config changes, while building.
  useEffect(() => {
    if (!parsed || !isBuildingDraft) return;
    const hasSizeWeight = draft.columnMappings.some((m) => m.field === "size_weight_kg") || draft.fixedCellMappings.some((m) => m.field === "size_weight_kg");
    if (!hasSizeWeight && draft.columnMappings.length === 0 && draft.fixedCellMappings.length === 0) return;

    const timeout = setTimeout(() => {
      void fetchPreviewForDraft(parsed.sourceFileId, draft);
    }, 400);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, parsed, isBuildingDraft]);

  function setColumnField(columnIndex: number, field: MappedField) {
    setDraft((current) => ({
      ...current,
      columnMappings: [
        ...current.columnMappings.filter((m) => m.columnIndex !== columnIndex),
        ...(field === "ignore" ? [] : [{ columnIndex, field }])
      ]
    }));
  }

  function setColumnDateFormat(columnIndex: number, dateFormat: DateFormat) {
    setDraft((current) => ({
      ...current,
      columnMappings: current.columnMappings.map((m) => (m.columnIndex === columnIndex ? { ...m, dateFormat } : m))
    }));
  }

  function toggleFixedCell(rowIndex: number, columnIndex: number, field: MappedField) {
    setDraft((current) => {
      const exists = current.fixedCellMappings.some((m) => m.rowIndex === rowIndex && m.columnIndex === columnIndex);
      return {
        ...current,
        fixedCellMappings: exists
          ? current.fixedCellMappings.filter((m) => !(m.rowIndex === rowIndex && m.columnIndex === columnIndex))
          : [...current.fixedCellMappings, { rowIndex, columnIndex, field }]
      };
    });
  }

  const columnFieldByIndex = useMemo(() => {
    const map = new Map<number, MappedField>();
    for (const m of draft.columnMappings) map.set(m.columnIndex, m.field);
    return map;
  }, [draft.columnMappings]);

  const fixedCellKeys = useMemo(() => new Set(draft.fixedCellMappings.map((m) => `${m.rowIndex}:${m.columnIndex}`)), [draft.fixedCellMappings]);

  // Every unique raw value seen in mapped Size Label / Market Grade columns
  // across the current preview's rows, with total kg — the spec's "show all
  // unique detected values with their raw kg totals" requirement.
  const uniqueValues = useMemo(() => {
    if (!preview) return { sizeLabels: [] as Array<{ value: string; kg: number }>, marketGrades: [] as Array<{ value: string; kg: number }> };

    const sizeLabelTotals = new Map<string, number>();
    const marketGradeTotals = new Map<string, number>();

    for (const group of preview.preview.groups) {
      for (const row of group.rows) {
        const kg = row.sizeWeightKg ?? 0;
        if (row.sizeLabelRaw) sizeLabelTotals.set(row.sizeLabelRaw, (sizeLabelTotals.get(row.sizeLabelRaw) ?? 0) + kg);
        if (row.marketGradeRaw) marketGradeTotals.set(row.marketGradeRaw, (marketGradeTotals.get(row.marketGradeRaw) ?? 0) + kg);
      }
    }

    return {
      sizeLabels: Array.from(sizeLabelTotals.entries()).map(([value, kg]) => ({ value, kg })).sort((a, b) => a.value.localeCompare(b.value)),
      marketGrades: Array.from(marketGradeTotals.entries()).map(([value, kg]) => ({ value, kg })).sort((a, b) => a.value.localeCompare(b.value))
    };
  }, [preview]);

  function upsertValueMapping(next: ValueMapping) {
    setDraft((current) => ({
      ...current,
      valueMappings: [
        ...current.valueMappings.filter((v) => !(v.sourceField === next.sourceField && v.rawValue === next.rawValue)),
        next
      ]
    }));
  }

  function addRule() {
    setDraft((current) => ({
      ...current,
      rules: [
        ...current.rules,
        {
          id: `rule-${Date.now()}-${current.rules.length}`,
          priority: current.rules.length + 1,
          conditions: [{ field: "market_grade", operator: "equals", value: "" }],
          conditionLogic: "AND",
          action: "ignore"
        }
      ]
    }));
  }

  function updateRule(id: string, patch: Partial<ConditionalRowRule>) {
    setDraft((current) => ({ ...current, rules: current.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  }

  function removeRule(id: string) {
    setDraft((current) => ({ ...current, rules: current.rules.filter((r) => r.id !== id) }));
  }

  async function handleSaveTemplate() {
    if (!parsed) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      const res = await apiFetch(TEMPLATES_URL, {
        method: "POST",
        body: JSON.stringify({
          name: templateName || "Untitled template",
          sourceFileId: parsed.sourceFileId,
          ...draft
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Save failed (${res.status})`);
      }
      const created = (await res.json()) as { id: string };
      setActiveTemplateId(created.id);
      setSaveStatus("Template saved.");
      await fetchPreviewForTemplate(parsed.sourceFileId, created.id);
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : "Failed to save template.");
    } finally {
      setSaving(false);
    }
  }

  async function handleImportGroup(group: NormalizedGroup) {
    if (!parsed || !activeTemplateId) return;
    setImportingKey(group.groupKey);
    setImportStatus((current) => ({ ...current, [group.groupKey]: "" }));
    try {
      const res = await apiFetch(IMPORT_URL, {
        method: "POST",
        body: JSON.stringify({
          sourceFileId: parsed.sourceFileId,
          templateId: activeTemplateId,
          groupKey: group.groupKey,
          approvedGroup: group
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Import failed (${res.status})`);
      }
      const body = (await res.json()) as { mode: "create" | "append" };
      setImportStatus((current) => ({ ...current, [group.groupKey]: `Imported (${body.mode}).` }));
    } catch (err) {
      setImportStatus((current) => ({
        ...current,
        [group.groupKey]: err instanceof Error ? err.message : "Import failed."
      }));
    } finally {
      setImportingKey(null);
    }
  }

  return (
    <div className="coming-soon-card csv-template-builder">
      <h2>CSV Import Template Builder</h2>
      <p>
        Upload any CSV export. If its layout matches a saved template, it&rsquo;s recognized automatically. Otherwise,
        map its columns once and save it as a reusable template for your organization.
      </p>

      <PendingCsvImportsSection
        items={pendingItems}
        loading={pendingLoading}
        error={pendingError}
        resumingPendingId={resumingPendingId}
        importingKey={importingKey}
        importStatus={importStatus}
        onSetUpTemplate={handleSetUpTemplateFromPending}
        onImportGroup={handleImportPendingGroup}
        onRefresh={fetchPendingItems}
      />

      <h3>Upload a new file</h3>
      <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFileChange} disabled={uploading} />
      {uploading && <p>Parsing file&hellip;</p>}
      {uploadError && <p className="form-error">{uploadError}</p>}

      {parsed && (
        <div className="csv-template-summary">
          <p>
            {parsed.rowCount} rows &middot; {parsed.columnCount} columns &middot; delimiter{" "}
            <code>{parsed.delimiter === "\t" ? "\\t" : parsed.delimiter}</code> &middot; encoding {parsed.encoding}
          </p>

          {parsed.match.kind === "exact" && (
            <p className="form-success">Matched saved template: {parsed.match.templateName}.</p>
          )}

          {parsed.match.kind === "close" && closeMatchChoice === "pending" && (
            <div className="form-error">
              <p>
                This looks similar to &ldquo;{parsed.match.templateName}&rdquo; but the layout has changed. Review before
                importing.
              </p>
              <button type="button" onClick={() => { setActiveTemplateId(parsed.match.templateId); setCloseMatchChoice("use"); void fetchPreviewForTemplate(parsed.sourceFileId, parsed.match.templateId as string); }}>
                Use it anyway
              </button>
              <button type="button" onClick={() => setCloseMatchChoice("build")}>
                Build a new template
              </button>
            </div>
          )}

          {parsed.match.kind === "none" && <p>No saved template matches this layout. Map its columns below.</p>}
        </div>
      )}

      {isBuildingDraft && parsed && (
        <>
          <div className="csv-template-grid-wrapper">
            <table className="varieties-table csv-template-grid">
              <thead>
                <tr>
                  <th />
                  {parsed.grid[0]?.map((_, colIndex) => (
                    <th key={colIndex}>
                      <div>{columnLetter(colIndex)}</div>
                      <select
                        value={columnFieldByIndex.get(colIndex) ?? "ignore"}
                        onChange={(e) => setColumnField(colIndex, e.target.value as MappedField)}
                      >
                        {MAPPED_FIELDS.map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABELS[f]}
                          </option>
                        ))}
                      </select>
                      {columnFieldByIndex.get(colIndex) === "packed_date" && (
                        <select
                          value={draft.columnMappings.find((m) => m.columnIndex === colIndex)?.dateFormat ?? "YYYY-MM-DD"}
                          onChange={(e) => setColumnDateFormat(colIndex, e.target.value as DateFormat)}
                        >
                          {DATE_FORMATS.map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </select>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.grid.slice(0, 500).map((row, rowIndex) => (
                  <tr key={rowIndex} className={rowIndex === draft.headerRowIndex ? "csv-template-header-row" : undefined}>
                    <td className="csv-template-row-controls">
                      <span>{rowIndex + 1}</span>
                      <button type="button" onClick={() => setDraft((c) => ({ ...c, headerRowIndex: rowIndex }))} title="Set as header row">
                        H
                      </button>
                      <button type="button" onClick={() => setDraft((c) => ({ ...c, dataStartRowIndex: rowIndex }))} title="Set as first data row">
                        D
                      </button>
                    </td>
                    {row.map((cell, colIndex) => {
                      const isFixed = fixedCellKeys.has(`${rowIndex}:${colIndex}`);
                      return (
                        <td
                          key={colIndex}
                          className={isFixed ? "csv-template-fixed-cell" : undefined}
                          onDoubleClick={() => {
                            const field = window.prompt(
                              `Use cell (row ${rowIndex + 1}, ${columnLetter(colIndex)}) as a fixed value for which field? (${MAPPED_FIELDS.join(", ")})`,
                              "variety"
                            ) as MappedField | null;
                            if (field && MAPPED_FIELDS.includes(field)) toggleFixedCell(rowIndex, colIndex, field);
                          }}
                          title="Double-click to use this single cell as a fixed value"
                        >
                          {cell}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="recent-entries-footer">
            Showing {Math.min(parsed.grid.length, 500)} of {parsed.rowCount} rows. Double-click any cell to use it as a
            fixed value instead of a whole column (for report-style files where a value like variety or date appears
            once above the table).
          </p>

          {(uniqueValues.sizeLabels.length > 0 || uniqueValues.marketGrades.length > 0) && (
            <ValueMappingPanel
              sizeLabels={uniqueValues.sizeLabels}
              marketGrades={uniqueValues.marketGrades}
              valueMappings={draft.valueMappings}
              yieldSizes={yieldSizes}
              onChange={upsertValueMapping}
            />
          )}

          <RuleEditor rules={draft.rules} yieldSizes={yieldSizes} onAdd={addRule} onUpdate={updateRule} onRemove={removeRule} />

          <div className="csv-template-save-row">
            <input
              type="text"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Template name (e.g. FlowMaster CSV Export)"
            />
            <button type="button" className="cases-entry-open-button" onClick={handleSaveTemplate} disabled={saving || !templateName.trim()}>
              {saving ? "Saving..." : "Save as template"}
            </button>
            {saveStatus && <span>{saveStatus}</span>}
          </div>
        </>
      )}

      {previewLoading && <p>Building preview&hellip;</p>}
      {previewError && <p className="form-error">{previewError}</p>}

      {preview && (
        <PreviewPanel
          preview={preview.preview}
          layoutMismatch={preview.layoutMismatch}
          canImportOverall={Boolean(activeTemplateId)}
          importingKey={importingKey}
          importStatus={importStatus}
          onImport={handleImportGroup}
        />
      )}
    </div>
  );
}

function ValueMappingPanel({
  sizeLabels,
  marketGrades,
  valueMappings,
  yieldSizes,
  onChange
}: {
  sizeLabels: Array<{ value: string; kg: number }>;
  marketGrades: Array<{ value: string; kg: number }>;
  valueMappings: ValueMapping[];
  yieldSizes: YieldSizeOption[];
  onChange: (mapping: ValueMapping) => void;
}) {
  function rowFor(sourceField: "size_label" | "market_grade", rawValue: string): ValueMapping {
    return valueMappings.find((v) => v.sourceField === sourceField && v.rawValue === rawValue) ?? { sourceField, rawValue, action: "unresolved" };
  }

  function renderRows(sourceField: "size_label" | "market_grade", values: Array<{ value: string; kg: number }>) {
    return values.map(({ value, kg }) => {
      const current = rowFor(sourceField, value);
      return (
        <tr key={value}>
          <td>{value}</td>
          <td>{kg.toFixed(3)}</td>
          <td>
            <select
              value={current.action}
              onChange={(e) =>
                onChange({ ...current, action: e.target.value as ValueMappingAction })
              }
            >
              <option value="unresolved">Leave unresolved</option>
              <option value="map">Map to existing size</option>
              <option value="create">Create new size</option>
              <option value="ignore">Ignore</option>
              <option value="distribute">Distribute across sizes</option>
              <option value="subtotal">Treat as subtotal</option>
            </select>
          </td>
          <td>
            {current.action === "map" && (
              <select value={current.targetSizeId ?? ""} onChange={(e) => onChange({ ...current, targetSizeId: e.target.value })}>
                <option value="">Select size&hellip;</option>
                {yieldSizes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            {current.action === "create" && (
              <input
                type="text"
                value={current.newSizeName ?? ""}
                onChange={(e) => onChange({ ...current, newSizeName: e.target.value })}
                placeholder="New size name"
              />
            )}
            {current.action === "distribute" && (
              <select
                multiple
                value={current.distributeSizeIds ?? []}
                onChange={(e) =>
                  onChange({
                    ...current,
                    distributeSizeIds: Array.from(e.target.selectedOptions).map((o) => o.value)
                  })
                }
              >
                {yieldSizes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </td>
        </tr>
      );
    });
  }

  return (
    <div className="csv-template-value-mapping">
      <h3>Size &amp; Market/Grade values</h3>
      <table className="varieties-table">
        <thead>
          <tr>
            <th>Raw value</th>
            <th>Total kg</th>
            <th>Action</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {renderRows("size_label", sizeLabels)}
          {renderRows("market_grade", marketGrades)}
        </tbody>
      </table>
    </div>
  );
}

function RuleEditor({
  rules,
  yieldSizes,
  onAdd,
  onUpdate,
  onRemove
}: {
  rules: ConditionalRowRule[];
  yieldSizes: YieldSizeOption[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<ConditionalRowRule>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="csv-template-rules">
      <h3>Conditional row rules</h3>
      <p>Example: if Market/Grade = &ldquo;Class 1&rdquo; and Size Label = &ldquo;SM&rdquo;, map to Small.</p>
      {rules.map((rule) => (
        <div key={rule.id} className="csv-template-rule-row">
          <span>#{rule.priority}</span>
          {rule.conditions.map((cond, condIndex) => (
            <span key={condIndex} className="csv-template-rule-condition">
              <select
                value={cond.field}
                onChange={(e) => {
                  const conditions = [...rule.conditions];
                  conditions[condIndex] = { ...cond, field: e.target.value as MappedField };
                  onUpdate(rule.id, { conditions });
                }}
              >
                {MAPPED_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {FIELD_LABELS[f]}
                  </option>
                ))}
              </select>
              <select
                value={cond.operator}
                onChange={(e) => {
                  const conditions = [...rule.conditions];
                  conditions[condIndex] = { ...cond, operator: e.target.value as RuleOperator };
                  onUpdate(rule.id, { conditions });
                }}
              >
                <option value="equals">equals</option>
                <option value="not_equals">does not equal</option>
                <option value="contains">contains</option>
                <option value="is_blank">is blank</option>
                <option value="is_not_blank">is not blank</option>
              </select>
              {cond.operator !== "is_blank" && cond.operator !== "is_not_blank" && (
                <input
                  type="text"
                  value={cond.value ?? ""}
                  onChange={(e) => {
                    const conditions = [...rule.conditions];
                    conditions[condIndex] = { ...cond, value: e.target.value };
                    onUpdate(rule.id, { conditions });
                  }}
                />
              )}
            </span>
          ))}
          <button
            type="button"
            onClick={() =>
              onUpdate(rule.id, { conditions: [...rule.conditions, { field: "market_grade", operator: "equals", value: "" }] })
            }
          >
            + condition
          </button>
          {rule.conditions.length > 1 && (
            <select value={rule.conditionLogic} onChange={(e) => onUpdate(rule.id, { conditionLogic: e.target.value as "AND" | "OR" })}>
              <option value="AND">AND</option>
              <option value="OR">OR</option>
            </select>
          )}
          <select value={rule.action} onChange={(e) => onUpdate(rule.id, { action: e.target.value as RuleAction })}>
            <option value="ignore">Ignore</option>
            <option value="map_to_size">Map to size</option>
            <option value="distribute">Distribute</option>
            <option value="treat_as_subtotal">Treat as subtotal</option>
          </select>
          {rule.action === "map_to_size" && (
            <select value={rule.targetSizeId ?? ""} onChange={(e) => onUpdate(rule.id, { targetSizeId: e.target.value })}>
              <option value="">Select size&hellip;</option>
              {yieldSizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {rule.action === "distribute" && (
            <select
              multiple
              value={rule.distributeSizeIds ?? []}
              onChange={(e) => onUpdate(rule.id, { distributeSizeIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}
            >
              {yieldSizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="danger" onClick={() => onRemove(rule.id)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={onAdd}>
        + Add rule
      </button>
    </div>
  );
}

function formatUploadedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function PendingCsvImportsSection({
  items,
  loading,
  error,
  resumingPendingId,
  importingKey,
  importStatus,
  onSetUpTemplate,
  onImportGroup,
  onRefresh
}: {
  items: PendingCsvItem[];
  loading: boolean;
  error: string | null;
  resumingPendingId: string | null;
  importingKey: string | null;
  importStatus: Record<string, string>;
  onSetUpTemplate: (item: PendingCsvItem) => void;
  onImportGroup: (item: PendingCsvItem, group: NormalizedGroup) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="csv-template-pending-section">
      <div className="csv-template-pending-header">
        <h3>Pending CSV Imports</h3>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!loading && items.length === 0 && !error && <p>No pending CSV imports right now.</p>}

      {items.map((item) => (
        <div key={item.id} className="csv-template-pending-card">
          <div className="csv-template-pending-card-header">
            <strong>{item.sourceFilename}</strong>
            <span className="recent-entries-footer">{formatUploadedAt(item.uploadedAt)}</span>
          </div>

          {item.error && <p className="form-error">{item.error}</p>}

          {item.needsTemplate ? (
            <>
              <p>
                {item.matchKind === "close"
                  ? "This file's layout closely resembles a saved template, but doesn't match exactly. Review and confirm before importing."
                  : "No saved template matches this file's layout yet."}
              </p>
              <button
                type="button"
                className="cases-entry-open-button"
                disabled={resumingPendingId === item.id || !item.sourceFileId}
                onClick={() => onSetUpTemplate(item)}
              >
                {resumingPendingId === item.id ? "Loading..." : "Set up CSV Template"}
              </button>
            </>
          ) : (
            <>
              <p>
                Matched template: <strong>{item.templateName ?? "Unknown"}</strong>
                {item.templateVersion !== null ? ` (v${item.templateVersion})` : ""} &middot; <span className="form-success">Exact match</span>
              </p>

              {item.preview?.groups.map((group) => {
                const groupIssues = item.preview!.validationIssues.filter((i) => !i.groupKey || i.groupKey === group.groupKey);
                const canImportGroup = groupIssues.length === 0;
                return (
                  <div key={group.groupKey} className="csv-template-preview-group">
                    <p>
                      <strong>{group.varietyRaw ?? "Unknown variety"}</strong> &middot; {group.packedDate ?? "Not recorded"} &middot; Year{" "}
                      {group.isoYear ?? "?"} Week {group.isoWeek ?? "?"}
                      {group.lotNumber ? ` · Lot ${group.lotNumber}` : ""}
                    </p>
                    <p>
                      Final mapped kg: {group.reconciliation.recognizedSizeKg.toFixed(2)} &middot; AFW{" "}
                      {group.averageFruitWeightG !== null ? `${group.averageFruitWeightG.toFixed(1)} g` : "-"} &middot; Reconciliation:{" "}
                      {group.reconciliation.unexplainedDifference ? (
                        <span className="form-error">unexplained difference</span>
                      ) : (
                        <span className="form-success">OK</span>
                      )}
                    </p>
                    {groupIssues.length > 0 && (
                      <ul className="form-error">
                        {groupIssues.map((issue, i) => (
                          <li key={i}>{issue.message}</li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      className="cases-entry-open-button"
                      disabled={!canImportGroup || importingKey === group.groupKey}
                      onClick={() => onImportGroup(item, group)}
                    >
                      {importingKey === group.groupKey ? "Importing..." : "Import"}
                    </button>
                    {importStatus[group.groupKey] && <span> {importStatus[group.groupKey]}</span>}
                  </div>
                );
              })}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function PreviewPanel({
  preview,
  layoutMismatch,
  canImportOverall,
  importingKey,
  importStatus,
  onImport
}: {
  preview: NormalizedPreview;
  layoutMismatch: boolean;
  canImportOverall: boolean;
  importingKey: string | null;
  importStatus: Record<string, string>;
  onImport: (group: NormalizedGroup) => void;
}) {
  return (
    <div className="csv-template-preview">
      <h3>Normalized preview</h3>
      {layoutMismatch && <p className="form-error">This file&rsquo;s structure no longer matches the template. Review carefully.</p>}

      {preview.validationIssues.length > 0 && (
        <ul className="form-error csv-template-issue-list">
          {preview.validationIssues.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}

      {preview.groups.map((group) => {
        const groupIssues = preview.validationIssues.filter((i) => !i.groupKey || i.groupKey === group.groupKey);
        const canImportGroup = canImportOverall && groupIssues.length === 0;
        return (
          <div key={group.groupKey} className="csv-template-preview-group">
            <h4>
              {group.varietyRaw ?? "Unknown variety"} &middot; {group.packedDate ?? "Not recorded"} &middot; Year {group.isoYear ?? "?"} Week{" "}
              {group.isoWeek ?? "?"} {group.lotNumber ? `· Lot ${group.lotNumber}` : ""}
            </h4>
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Size</th>
                  <th>kg</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(group.sizeKg).map(([name, kg]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{kg.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <table className="varieties-table csv-template-reconciliation">
              <tbody>
                <tr><td>Raw row weight</td><td>{group.reconciliation.rawRowWeightKg.toFixed(2)} kg</td></tr>
                <tr><td>Recognized size kg</td><td>{group.reconciliation.recognizedSizeKg.toFixed(2)} kg</td></tr>
                <tr><td>Distributed kg</td><td>{group.reconciliation.distributedKg.toFixed(2)} kg</td></tr>
                <tr><td>Ignored kg</td><td>{group.reconciliation.ignoredKg.toFixed(2)} kg</td></tr>
                <tr><td>Unresolved kg</td><td>{group.reconciliation.unresolvedKg.toFixed(2)} kg</td></tr>
                <tr><td>Subtotal rows (excluded)</td><td>{group.reconciliation.subtotalKg.toFixed(2)} kg</td></tr>
                {group.reconciliation.lotTotalKg !== null && (
                  <tr><td>Lot total (mapped)</td><td>{group.reconciliation.lotTotalKg.toFixed(2)} kg</td></tr>
                )}
                {group.reconciliation.difference !== null && (
                  <tr>
                    <td>Difference</td>
                    <td className={group.reconciliation.unexplainedDifference ? "form-error" : undefined}>
                      {group.reconciliation.difference.toFixed(2)} kg {group.reconciliation.unexplainedDifference ? "(unexplained)" : ""}
                    </td>
                  </tr>
                )}
                <tr><td>Waste kg</td><td>{group.wasteKg.toFixed(2)} kg</td></tr>
                <tr><td>Piece count</td><td>{group.pieceCount}</td></tr>
                <tr><td>Average fruit weight</td><td>{group.averageFruitWeightG !== null ? `${group.averageFruitWeightG.toFixed(1)} g` : "-"}</td></tr>
              </tbody>
            </table>

            {groupIssues.length > 0 && (
              <ul className="form-error">
                {groupIssues.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            )}

            <button
              type="button"
              className="cases-entry-open-button"
              disabled={!canImportGroup || importingKey === group.groupKey}
              onClick={() => onImport(group)}
            >
              {importingKey === group.groupKey ? "Importing..." : "Import"}
            </button>
            {importStatus[group.groupKey] && <span> {importStatus[group.groupKey]}</span>}
          </div>
        );
      })}
    </div>
  );
}
