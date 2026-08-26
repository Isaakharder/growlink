import { ChangeEvent, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { apiFetch } from "../lib/api";
import {
  MAPPING_TYPES,
  MAPPING_TYPE_LABELS,
  MAPPING_TYPE_COLORS,
  cellKey,
  parseCellKey,
  rectCells,
  applySelectionModifier,
  coversAllDataRows,
  inferIgnoreRules,
  plainLanguageIgnoreRule,
  type MappingType,
  type CellCoord,
  type CellKey,
  type ColumnAssignments,
  type SelectionModifier,
  type InferredIgnoreRule
} from "./csvVisualMapping";

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
type RuleCondition = { field?: MappedField; columnIndex?: number; operator: RuleOperator; value?: string };
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

type TemplateSummary = {
  id: string;
  templateGroupId: string;
  name: string;
  version: number;
  isActive: boolean;
  isCurrent: boolean;
  delimiter: string;
  headerRowIndex: number;
  columnCount: number | null;
  layoutSummary: string;
  mappedFieldsCount: number;
  rulesCount: number;
  valueMappingsCount: number;
  createdBy: string;
  updatedBy: string;
  createdByName: string;
  updatedByName: string;
  createdAt: string;
  updatedAt: string;
};

type TemplateDetail = TemplateSummary & {
  dataStartRowIndex: number;
  dataEndRowIndex: number | null;
  skipRowIndexes: number[];
  blankRowBehavior: "skip" | "stop";
  columnMappings: ColumnMapping[];
  fixedCellMappings: FixedCellMapping[];
  valueMappings: ValueMapping[];
  rules: ConditionalRowRule[];
};

const TEMPLATE_FIELD_LABELS: Partial<Record<MappedField, string>> = {
  variety: "Variety",
  packed_date: "Pack Date",
  lot_number: "Lot Number",
  size_label: "Size Label",
  size_weight_kg: "Size Weight kg",
  average_fruit_weight_g: "Average Fruit Weight g",
  run_number: "Run Number",
  piece_count: "Piece Count",
  market_grade: "Market/Grade",
  year: "Year",
  week: "Week",
  waste_kg: "Waste kg",
  total_lot_weight: "Total Lot Weight",
  custom: "Custom"
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

const VISUAL_RULE_PREFIX = "visual-";

type HistorySnapshot = {
  columnAssignments: ColumnAssignments;
  rowIgnoreSelections: Set<number>;
};

function cloneSnapshot(s: HistorySnapshot): HistorySnapshot {
  return { columnAssignments: new Map(s.columnAssignments), rowIgnoreSelections: new Set(s.rowIgnoreSelections) };
}

// ---------------------------------------------------------------------------
// Local persistence — so a failed save (rate-limited or otherwise) or an
// accidental refresh never destroys in-progress mapping work. Persists the
// full grid + draft + visual-tool state; restored automatically on mount.
// ---------------------------------------------------------------------------

const PERSIST_KEY = "growlink:csv-template-builder:draft:v1";

type PersistedBuilderState = {
  parsed: ParseGridResponse;
  draft: DraftConfig;
  columnAssignments: Array<[number, MappingType]>;
  rowIgnoreSelections: number[];
  packDateFormat: DateFormat;
  templateName: string;
  closeMatchChoice: "pending" | "use" | "build";
  savedAt: number;
};

function savePersistedBuilderState(state: PersistedBuilderState) {
  try {
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
  } catch {
    // Storage full/unavailable — persistence is a convenience, not required for correctness.
  }
}

function loadPersistedBuilderState(): PersistedBuilderState | null {
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedBuilderState;
  } catch {
    return null;
  }
}

function clearPersistedBuilderState() {
  try {
    window.localStorage.removeItem(PERSIST_KEY);
  } catch {
    // Ignore — nothing to clean up if storage isn't available.
  }
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

  // Single shared 429 notice for BOTH preview and save — whichever action
  // hits its rate limit, this is the only place the message renders, so it
  // never shows up twice (once from previewError, once from saveStatus).
  const [rateLimitNotice, setRateLimitNotice] = useState<{ message: string; retryAt: number; source: "preview" | "save" } | null>(null);
  const [rateLimitCountdown, setRateLimitCountdown] = useState(0);
  const [restoredNotice, setRestoredNotice] = useState(false);

  // ── Saved CSV Templates ─────────────────────────────────────────────────
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [highlightedTemplateId, setHighlightedTemplateId] = useState<string | null>(null);
  const [viewingTemplate, setViewingTemplate] = useState<TemplateDetail | null>(null);
  const [viewingTemplateLoading, setViewingTemplateLoading] = useState(false);
  const [viewingTemplateError, setViewingTemplateError] = useState<string | null>(null);
  const [testingTemplate, setTestingTemplate] = useState<TemplateSummary | null>(null);
  const [testingBusy, setTestingBusy] = useState(false);
  const [testResult, setTestResult] = useState<PreviewResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteConfirmTemplate, setDeleteConfirmTemplate] = useState<TemplateSummary | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [templateActionError, setTemplateActionError] = useState<string | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingTemplateName, setEditingTemplateName] = useState<string | null>(null);
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null);
  const testFileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Visual mapping tool state ──────────────────────────────────────────
  const [activeTool, setActiveTool] = useState<MappingType>("variety");
  const [packDateFormat, setPackDateFormat] = useState<DateFormat>("YYYY-MM-DD");
  const [columnAssignments, setColumnAssignments] = useState<ColumnAssignments>(new Map());
  const [rowIgnoreSelections, setRowIgnoreSelections] = useState<Set<number>>(new Set());
  const [selection, setSelection] = useState<Set<CellKey>>(new Set());
  const [flashCells, setFlashCells] = useState<Set<CellKey>>(new Set());
  const [rowClickHint, setRowClickHint] = useState<string | null>(null);
  const [ignoreHint, setIgnoreHint] = useState<string | null>(null);
  const [nonTranslatableWarning, setNonTranslatableWarning] = useState<string | null>(null);
  const [clearAllConfirm, setClearAllConfirm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ rules: InferredIgnoreRule[]; unresolvedRows: number[] } | null>(null);
  const [past, setPast] = useState<HistorySnapshot[]>([]);
  const [future, setFuture] = useState<HistorySnapshot[]>([]);
  const isDraggingRef = useRef(false);
  const dragAnchorRef = useRef<CellCoord | null>(null);
  const lastAnchorRef = useRef<CellCoord | null>(null);

  // Preview-request lifecycle: only one in flight at a time (aborting any
  // obsolete one), a debounce timer, and the last payload actually sent so
  // an unchanged draft never re-submits.
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPreviewPayloadRef = useRef<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch(YIELD_SIZES_URL);
      if (!res.ok) return;
      const body = (await res.json()) as YieldSizeOption[];
      setYieldSizes(body);
    })();
    void fetchPendingItems();
    void fetchTemplates();

    // Restore any in-progress mapping work — e.g. after a refresh that
    // followed a failed/rate-limited save — so it is never silently lost.
    const persisted = loadPersistedBuilderState();
    if (persisted) {
      setParsed(persisted.parsed);
      setDraft(persisted.draft);
      setColumnAssignments(new Map(persisted.columnAssignments));
      setRowIgnoreSelections(new Set(persisted.rowIgnoreSelections));
      setPackDateFormat(persisted.packDateFormat);
      setTemplateName(persisted.templateName);
      setCloseMatchChoice(persisted.closeMatchChoice);
      setRestoredNotice(true);
    }
  }, []);

  const isBuildingDraft =
    parsed !== null &&
    (parsed.match.kind === "none" || (parsed.match.kind === "close" && closeMatchChoice === "build") || editingTemplateId !== null);

  // Persist in-progress mapping work locally (debounced) so a refresh —
  // including one that follows a failed or rate-limited save — never
  // destroys it. Cleared on a successful save (see handleSaveTemplate) or
  // when the user explicitly starts over with a new upload.
  useEffect(() => {
    if (!parsed || !isBuildingDraft) return;
    const timeout = setTimeout(() => {
      savePersistedBuilderState({
        parsed,
        draft,
        columnAssignments: Array.from(columnAssignments.entries()),
        rowIgnoreSelections: Array.from(rowIgnoreSelections),
        packDateFormat,
        templateName,
        closeMatchChoice,
        savedAt: Date.now()
      });
    }, 800);
    return () => clearTimeout(timeout);
  }, [parsed, isBuildingDraft, draft, columnAssignments, rowIgnoreSelections, packDateFormat, templateName, closeMatchChoice]);

  // Live countdown for the shared rate-limit notice.
  useEffect(() => {
    if (!rateLimitNotice) {
      setRateLimitCountdown(0);
      return;
    }
    const tick = () => setRateLimitCountdown(Math.max(0, Math.ceil((rateLimitNotice.retryAt - Date.now()) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [rateLimitNotice]);

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

  async function fetchTemplates() {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const res = await apiFetch(TEMPLATES_URL);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load saved templates (${res.status})`);
      }
      setTemplates((await res.json()) as TemplateSummary[]);
    } catch (err) {
      setTemplatesError(err instanceof Error ? err.message : "Failed to load saved templates.");
    } finally {
      setTemplatesLoading(false);
    }
  }

  function resetVisualState() {
    setColumnAssignments(new Map());
    setRowIgnoreSelections(new Set());
    setSelection(new Set());
    setPast([]);
    setFuture([]);
    setActiveTool("variety");
    setPackDateFormat("YYYY-MM-DD");
    setNonTranslatableWarning(null);
    setSaveConfirm(null);
    setRestoredNotice(false);
    clearPersistedBuilderState();
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
      setDraft((current) => ({ ...emptyDraft(), delimiter: body.delimiter, headerRowIndex: 0, dataStartRowIndex: 1, valueMappings: current.valueMappings, rules: current.rules }));
      resetVisualState();
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

  // "Reprocess with saved template" — for a legacy/needs-template pending
  // CSV whose raw text is preserved, lets the user pick any of the org's
  // saved templates directly (no re-upload) and see it normalized via the
  // exact same buildCsvPreview the auto-matched path uses.
  async function handleReprocessPendingWithTemplate(item: PendingCsvItem, templateId: string) {
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
      setDraft(emptyDraft());
      resetVisualState();
      setActiveTemplateId(templateId);
      setCloseMatchChoice("use");
      setTemplateName(body.filename.replace(/\.csv$/i, ""));
      setParsed({
        sourceFileId: body.sourceFileId,
        grid: body.grid,
        rowCount: body.rowCount,
        columnCount: body.columnCount,
        delimiter: body.delimiter,
        encoding: "utf-8",
        match: body.match
      });
      await fetchPreviewForTemplate(body.sourceFileId, templateId);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to reprocess this file with the selected template.");
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

    const wasEditing = editingTemplateId;

    setUploadError(null);
    setUploading(true);
    setParsed(null);
    setPreview(null);
    setActiveTemplateId(null);
    setCloseMatchChoice("pending");
    setDraft(emptyDraft());
    resetVisualState();
    setTemplateName(wasEditing && editingTemplateName ? editingTemplateName : file.name.replace(/\.csv$/i, ""));

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

      if (wasEditing) {
        await loadTemplateIntoBuilder(wasEditing);
      } else if (body.match.kind === "exact" && body.match.templateId) {
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

  // Reverse-projects a saved template's column mappings into the visual
  // tool's columnAssignments (best-effort: only the 9 user-facing field
  // types are representable visually — anything else, e.g. an older
  // template's market_grade/custom column, still loads into draft.rules/
  // draft.columnMappings via the raw config but won't show as a colored
  // column until re-assigned). Rules and value mappings load as-is into
  // the Advanced editor and the Size/Market values panel respectively.
  async function loadTemplateIntoBuilder(templateId: string) {
    try {
      const res = await apiFetch(`${TEMPLATES_URL}/${templateId}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load template for editing (${res.status})`);
      }
      const detail = (await res.json()) as TemplateDetail;

      const nextAssignments: ColumnAssignments = new Map();
      let packDate: DateFormat = "YYYY-MM-DD";
      for (const m of detail.columnMappings) {
        if ((MAPPING_TYPES as readonly string[]).includes(m.field)) {
          nextAssignments.set(m.columnIndex, m.field as MappingType);
          if (m.field === "packed_date" && m.dateFormat) packDate = m.dateFormat;
        }
      }
      setColumnAssignments(nextAssignments);
      setPackDateFormat(packDate);
      setDraft((current) => ({
        ...current,
        headerRowIndex: detail.headerRowIndex,
        dataStartRowIndex: detail.dataStartRowIndex,
        dataEndRowIndex: detail.dataEndRowIndex,
        skipRowIndexes: detail.skipRowIndexes,
        blankRowBehavior: detail.blankRowBehavior,
        fixedCellMappings: detail.fixedCellMappings,
        valueMappings: detail.valueMappings,
        rules: detail.rules
      }));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to load the template's existing mappings.");
    }
  }

  // Parses a 429 response body (see server/src/middleware/rateLimiters.ts)
  // and records ONE shared notice — this is the single place a rate-limit
  // message is ever shown, so preview and save hitting 429 back-to-back
  // never renders the same message twice.
  async function handleRateLimited(res: Response, source: "preview" | "save") {
    const body = (await res.json().catch(() => null)) as { message?: string; retryAfterSeconds?: number } | null;
    const retryAfterSeconds = body?.retryAfterSeconds ?? Number(res.headers.get("retry-after")) ?? 60;
    setRateLimitNotice({
      message: body?.message ?? "Too many requests. Please wait before retrying.",
      retryAt: Date.now() + retryAfterSeconds * 1000,
      source
    });
  }

  async function fetchPreviewForTemplate(sourceFileId: string, templateId: string) {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;

    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await apiFetch(PREVIEW_URL, {
        method: "POST",
        body: JSON.stringify({ sourceFileId, templateId }),
        signal: controller.signal
      });
      if (res.status === 429) {
        await handleRateLimited(res, "preview");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Preview failed (${res.status})`);
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setPreviewError(err instanceof Error ? err.message : "Failed to build preview.");
    } finally {
      if (previewAbortRef.current === controller) {
        setPreviewLoading(false);
        previewAbortRef.current = null;
      }
    }
  }

  // Single-flight, cancellable, dedup'd preview fetch — the actual fix for
  // "excessive preview requests": at most one request in flight (any prior
  // one is aborted, not left to complete and race), and an unchanged
  // payload (same sourceFileId + draftConfig) is never resubmitted.
  async function fetchPreviewForDraft(sourceFileId: string, draftConfig: DraftConfig, payloadKey: string) {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    lastPreviewPayloadRef.current = payloadKey;

    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await apiFetch(PREVIEW_URL, {
        method: "POST",
        body: JSON.stringify({ sourceFileId, draftConfig }),
        signal: controller.signal
      });
      if (res.status === 429) {
        await handleRateLimited(res, "preview");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Preview failed (${res.status})`);
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // superseded by a newer request, not a real failure
      setPreviewError(err instanceof Error ? err.message : "Failed to build preview.");
      setPreview(null);
    } finally {
      if (previewAbortRef.current === controller) {
        setPreviewLoading(false);
        previewAbortRef.current = null;
      }
    }
  }

  // Every data row index per the current header/data-start/data-end/skip
  // settings — mirrors the server's resolveDataRowIndexes closely enough
  // for selection/inference purposes (final import always re-validates).
  const dataRowIndexes = useMemo(() => {
    if (!parsed) return [];
    const skip = new Set(draft.skipRowIndexes);
    const end = draft.dataEndRowIndex ?? parsed.grid.length - 1;
    const indexes: number[] = [];
    for (let i = draft.dataStartRowIndex; i <= end && i < parsed.grid.length; i += 1) {
      if (i === draft.headerRowIndex) continue;
      if (skip.has(i)) continue;
      indexes.push(i);
    }
    return indexes;
  }, [parsed, draft.headerRowIndex, draft.dataStartRowIndex, draft.dataEndRowIndex, draft.skipRowIndexes]);

  const visualIgnoreInference = useMemo(() => {
    if (!parsed || rowIgnoreSelections.size === 0) return { rules: [] as InferredIgnoreRule[], unresolvedRows: [] as number[] };
    const kept = dataRowIndexes.filter((r) => !rowIgnoreSelections.has(r));
    return inferIgnoreRules(Array.from(rowIgnoreSelections), kept, parsed.grid, columnAssignments, parsed.grid[draft.headerRowIndex] ?? []);
  }, [parsed, rowIgnoreSelections, dataRowIndexes, columnAssignments, draft.headerRowIndex]);

  // Keeps draft.columnMappings / draft.rules in sync with the visual tool's
  // state — the visual tool is the single source of truth for both; the
  // Advanced editor's manually-added rules (any id not prefixed "visual-")
  // are preserved untouched alongside the regenerated visual ones.
  useEffect(() => {
    setDraft((current) => {
      const columnMappings: ColumnMapping[] = [];
      for (const [columnIndex, field] of columnAssignments) {
        if (field === "ignore") continue;
        const mapping: ColumnMapping = { columnIndex, field: field as MappedField };
        if (field === "packed_date") mapping.dateFormat = packDateFormat;
        columnMappings.push(mapping);
      }

      const manualRules = current.rules.filter((r) => !r.id.startsWith(VISUAL_RULE_PREFIX));
      const visualRules: ConditionalRowRule[] = visualIgnoreInference.rules.map((r, i) => ({
        id: `${VISUAL_RULE_PREFIX}${r.columnIndex}-${i}`,
        priority: i + 1,
        conditionLogic: "OR",
        action: "ignore",
        conditions: [
          r.mappedField && r.mappedField !== "ignore"
            ? { field: r.mappedField as MappedField, operator: "equals" as const, value: r.value }
            : { columnIndex: r.columnIndex, operator: "equals" as const, value: r.value }
        ]
      }));

      return { ...current, columnMappings, rules: [...manualRules, ...visualRules] };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnAssignments, packDateFormat, visualIgnoreInference]);

  // Debounced live preview whenever the draft mapping config changes, while
  // building. Guarded three ways against "excessive preview requests":
  // (1) a payload-content hash skips the fetch entirely when the draft
  // hasn't actually changed (e.g. a re-render that produced a new object
  // reference with identical content), so this can never loop even if an
  // effect dependency's reference churns without a real change; (2) the
  // debounce timer is cleared/restarted on every dependency change, so a
  // burst of edits collapses into one request; (3) fetchPreviewForDraft
  // itself aborts any still-in-flight request before starting a new one.
  useEffect(() => {
    if (previewDebounceRef.current) {
      clearTimeout(previewDebounceRef.current);
      previewDebounceRef.current = null;
    }
    if (!parsed || !isBuildingDraft) return;
    const hasSizeWeight = draft.columnMappings.some((m) => m.field === "size_weight_kg") || draft.fixedCellMappings.some((m) => m.field === "size_weight_kg");
    if (!hasSizeWeight && draft.columnMappings.length === 0 && draft.fixedCellMappings.length === 0) return;

    const payloadKey = JSON.stringify({ sourceFileId: parsed.sourceFileId, draft });
    if (payloadKey === lastPreviewPayloadRef.current) return;

    previewDebounceRef.current = setTimeout(() => {
      previewDebounceRef.current = null;
      void fetchPreviewForDraft(parsed.sourceFileId, draft, payloadKey);
    }, 500);

    return () => {
      if (previewDebounceRef.current) {
        clearTimeout(previewDebounceRef.current);
        previewDebounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, parsed, isBuildingDraft]);

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

  const fixedCellKeys = useMemo(() => new Set(draft.fixedCellMappings.map((m) => `${m.rowIndex}:${m.columnIndex}`)), [draft.fixedCellMappings]);

  // Every unique raw value seen in mapped Size Label / Market Grade columns
  // across the current preview's rows, with total kg.
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

  // ── Visual mapping tool: selection + undo/redo ─────────────────────────

  function currentSnapshot(): HistorySnapshot {
    return cloneSnapshot({ columnAssignments, rowIgnoreSelections });
  }

  // Call BEFORE mutating columnAssignments/rowIgnoreSelections — captures
  // the pre-change state onto the undo stack and clears any redo stack
  // (a fresh change invalidates whatever could have been redone).
  function pushHistory() {
    setPast((p) => [...p, currentSnapshot()].slice(-50));
    setFuture([]);
  }

  function handleUndo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setFuture((f) => [currentSnapshot(), ...f]);
    setPast((p) => p.slice(0, -1));
    setColumnAssignments(new Map(prev.columnAssignments));
    setRowIgnoreSelections(new Set(prev.rowIgnoreSelections));
  }

  function handleRedo() {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [...p, currentSnapshot()]);
    setFuture((f) => f.slice(1));
    setColumnAssignments(new Map(next.columnAssignments));
    setRowIgnoreSelections(new Set(next.rowIgnoreSelections));
  }

  function clearSelection() {
    setSelection(new Set());
  }

  function requestClearAllMappings() {
    if (columnAssignments.size === 0 && rowIgnoreSelections.size === 0) return;
    setClearAllConfirm(true);
  }

  function executeClearAllMappings() {
    pushHistory();
    setColumnAssignments(new Map());
    setRowIgnoreSelections(new Set());
    setSelection(new Set());
    setClearAllConfirm(false);
  }

  function flash(cells: CellKey[]) {
    setFlashCells(new Set(cells));
    setTimeout(() => setFlashCells(new Set()), 600);
  }

  function applyFieldToColumn(columnIndex: number, cells: CellCoord[]) {
    const rows = cells.filter((c) => c.col === columnIndex).map((c) => c.row);
    if (!coversAllDataRows(rows, dataRowIndexes)) {
      setNonTranslatableWarning(
        `This selection doesn't cover the whole column, and assigning "${MAPPING_TYPE_LABELS[activeTool]}" to only part of a column isn't supported — select the entire column instead (click its header, or drag through every row), or use Ignore on the rows that don't belong.`
      );
      return;
    }
    pushHistory();
    setColumnAssignments((cur) => {
      const next = new Map(cur);
      next.set(columnIndex, activeTool);
      return next;
    });
    flash(rows.map((r) => cellKey(r, columnIndex)));
  }

  function applyIgnoreToCells(cells: CellCoord[]) {
    const byColumn = new Map<number, number[]>();
    for (const c of cells) {
      if (!byColumn.has(c.col)) byColumn.set(c.col, []);
      byColumn.get(c.col)!.push(c.row);
    }
    let appliedAny = false;
    let partialAny = false;
    const flashed: CellKey[] = [];
    pushHistory();
    setColumnAssignments((cur) => {
      const next = new Map(cur);
      for (const [col, rows] of byColumn) {
        if (coversAllDataRows(rows, dataRowIndexes)) {
          next.set(col, "ignore");
          appliedAny = true;
          for (const r of rows) flashed.push(cellKey(r, col));
        } else {
          partialAny = true;
        }
      }
      return next;
    });
    if (flashed.length > 0) flash(flashed);
    if (partialAny) {
      setIgnoreHint(
        appliedAny
          ? "Some selected columns were marked Ignore; partial-column selections were skipped — select a whole column, or use the row-number gutter to exclude specific rows entirely."
          : "Select a whole column to mark it Ignore, or use the row-number gutter to exclude specific rows entirely."
      );
      setTimeout(() => setIgnoreHint(null), 4000);
    }
  }

  function toggleRowIgnore(rowIndexes: number[], modifier: SelectionModifier) {
    pushHistory();
    setRowIgnoreSelections((cur) => {
      if (modifier === "toggle") {
        const next = new Set(cur);
        for (const r of rowIndexes) {
          if (next.has(r)) next.delete(r);
          else next.add(r);
        }
        return next;
      }
      if (modifier === "range") {
        return new Set([...cur, ...rowIndexes]);
      }
      // replace
      return new Set(rowIndexes);
    });
  }

  function cellsFromInteraction(anchor: CellCoord, target: CellCoord): CellCoord[] {
    return rectCells(anchor, target).filter((c) => dataRowIndexes.includes(c.row));
  }

  function handleCellMouseDown(row: number, col: number, e: ReactMouseEvent) {
    if (e.shiftKey && lastAnchorRef.current) {
      const cells = cellsFromInteraction(lastAnchorRef.current, { row, col });
      commitCells(cells, "range");
      return;
    }
    const anchor = { row, col };
    dragAnchorRef.current = anchor;
    isDraggingRef.current = true;
    lastAnchorRef.current = anchor;
    if (e.ctrlKey || e.metaKey) {
      commitCells([anchor], "toggle");
    } else {
      setSelection(new Set([cellKey(row, col)]));
    }
  }

  function handleCellMouseEnter(row: number, col: number, e: ReactMouseEvent) {
    if (!isDraggingRef.current || !dragAnchorRef.current) return;
    if (e.buttons !== 1) {
      isDraggingRef.current = false;
      return;
    }
    const cells = cellsFromInteraction(dragAnchorRef.current, { row, col });
    setSelection(new Set(cells.map((c) => cellKey(c.row, c.col))));
  }

  function handleCellMouseUp(row: number, col: number, e: ReactMouseEvent) {
    const wasDragging = isDraggingRef.current;
    isDraggingRef.current = false;
    if (e.ctrlKey || e.metaKey || (e.shiftKey && lastAnchorRef.current)) return; // already committed on mousedown

    if (wasDragging && dragAnchorRef.current) {
      const cells = cellsFromInteraction(dragAnchorRef.current, { row, col });
      commitCells(cells, "replace");
    } else {
      commitCells([{ row, col }], "replace");
    }
  }

  function commitCells(cells: CellCoord[], modifier: SelectionModifier) {
    setSelection((cur) => applySelectionModifier(cur, cells, modifier));
    if (activeTool === "ignore") {
      applyIgnoreToCells(cells);
    } else {
      const columns = new Set(cells.map((c) => c.col));
      for (const col of columns) applyFieldToColumn(col, cells);
    }
  }

  function handleColumnHeaderClick(columnIndex: number, e: ReactMouseEvent) {
    const cells = dataRowIndexes.map((r) => ({ row: r, col: columnIndex }));
    const modifier: SelectionModifier = e.ctrlKey || e.metaKey ? "toggle" : "replace";
    setSelection((cur) => applySelectionModifier(modifier === "replace" ? new Set<CellKey>() : cur, cells, modifier === "replace" ? "range" : modifier));
    if (activeTool === "ignore") {
      applyIgnoreToCells(cells);
    } else {
      applyFieldToColumn(columnIndex, cells);
    }
  }

  function handleRowNumberClick(rowIndex: number, e: ReactMouseEvent) {
    if (activeTool !== "ignore") {
      setRowClickHint('Row numbers are used with "Ignore" to exclude a whole row. Pick a cell or column header to assign a field.');
      setTimeout(() => setRowClickHint(null), 3500);
      return;
    }
    let rows = [rowIndex];
    let modifier: SelectionModifier = "replace";
    if (e.shiftKey && lastAnchorRef.current) {
      const start = Math.min(lastAnchorRef.current.row, rowIndex);
      const end = Math.max(lastAnchorRef.current.row, rowIndex);
      rows = dataRowIndexes.filter((r) => r >= start && r <= end);
      modifier = "range";
    } else if (e.ctrlKey || e.metaKey) {
      modifier = "toggle";
    }
    lastAnchorRef.current = { row: rowIndex, col: 0 };
    toggleRowIgnore(rows, modifier);
  }

  function handleSaveClick() {
    if (savingRef.current) return; // one submission in flight at a time
    if (visualIgnoreInference.unresolvedRows.length > 0 || visualIgnoreInference.rules.length > 0) {
      setSaveConfirm({ rules: visualIgnoreInference.rules, unresolvedRows: visualIgnoreInference.unresolvedRows });
      return;
    }
    void handleSaveTemplate();
  }

  // Resets the builder to its idle "no file uploaded" state. Called ONLY
  // after the server has actually confirmed a save succeeded — never on
  // failure, so a failed/rate-limited save always leaves every mapping
  // exactly as the user left it.
  function clearBuilderAfterSave() {
    // A preview request from just before the save may still be in flight
    // (or queued in the debounce timer) — without cancelling it here, its
    // response could arrive after the clear below and resurrect stale
    // preview data. Aborting also resets lastPreviewPayloadRef implicitly
    // via the next upload's fresh payload key.
    if (previewDebounceRef.current) {
      clearTimeout(previewDebounceRef.current);
      previewDebounceRef.current = null;
    }
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    lastPreviewPayloadRef.current = null;
    setPreviewLoading(false);
    setPreviewError(null);

    setParsed(null);
    setPreview(null);
    setActiveTemplateId(null);
    setCloseMatchChoice("pending");
    setDraft(emptyDraft());
    resetVisualState();
    setTemplateName("");
    setEditingTemplateId(null);
    setEditingTemplateName(null);
    setUploadError(null);
  }

  async function handleSaveTemplate() {
    if (!parsed || savingRef.current) return;
    savingRef.current = true;
    setSaveConfirm(null);
    setSaving(true);
    setSaveStatus(null);
    setSaveSuccessMessage(null);
    try {
      const isEdit = editingTemplateId !== null;
      const res = await apiFetch(isEdit ? `${TEMPLATES_URL}/${editingTemplateId}` : TEMPLATES_URL, {
        method: isEdit ? "PUT" : "POST",
        body: JSON.stringify({
          name: templateName || "Untitled template",
          sourceFileId: parsed.sourceFileId,
          ...draft
        })
      });
      if (res.status === 429) {
        await handleRateLimited(res, "save");
        return; // draft/columnAssignments untouched — nothing is cleared on a failed save
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Save failed (${res.status})`);
      }
      const savedTemplate = (await res.json()) as TemplateDetail;

      // Confirmed by the server — safe to refresh the list and clear the
      // builder now. Never leave the user wondering whether it saved.
      setSaveSuccessMessage(
        isEdit
          ? `Template "${savedTemplate.name}" updated (now version ${savedTemplate.version}). See it in Saved CSV Templates below.`
          : `Template "${savedTemplate.name}" saved. See it in Saved CSV Templates below.`
      );
      setHighlightedTemplateId(savedTemplate.id);
      await fetchTemplates();
      clearPersistedBuilderState();
      clearBuilderAfterSave();
    } catch (err) {
      // Deliberately does not touch draft/columnAssignments/rowIgnoreSelections —
      // a failed save must never lose the user's in-progress mapping work.
      setSaveStatus(
        `Template was NOT saved: ${err instanceof Error ? err.message : "an unexpected error occurred."} Your mappings are unchanged — fix the issue and try Save again.`
      );
    } finally {
      savingRef.current = false;
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

  // ── Saved CSV Templates: actions ───────────────────────────────────────

  useEffect(() => {
    if (!highlightedTemplateId) return;
    const timeout = setTimeout(() => setHighlightedTemplateId(null), 5000);
    return () => clearTimeout(timeout);
  }, [highlightedTemplateId]);

  async function handleViewMappings(template: TemplateSummary) {
    setViewingTemplateLoading(true);
    setViewingTemplateError(null);
    setViewingTemplate(null);
    try {
      const res = await apiFetch(`${TEMPLATES_URL}/${template.id}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to load template (${res.status})`);
      }
      setViewingTemplate((await res.json()) as TemplateDetail);
    } catch (err) {
      setViewingTemplateError(err instanceof Error ? err.message : "Failed to load template.");
    } finally {
      setViewingTemplateLoading(false);
    }
  }

  function handleEditTemplate(template: TemplateSummary) {
    setEditingTemplateId(template.id);
    setEditingTemplateName(template.name);
    setTemplateActionError(null);
    fileInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function handleDuplicateTemplate(template: TemplateSummary) {
    const name = window.prompt("Name for the duplicate:", `${template.name} (copy)`);
    if (name === null) return;
    setDuplicatingId(template.id);
    setTemplateActionError(null);
    try {
      const res = await apiFetch(`${TEMPLATES_URL}/${template.id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim() || undefined })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to duplicate template (${res.status})`);
      }
      const duplicated = (await res.json()) as TemplateDetail;
      setHighlightedTemplateId(duplicated.id);
      await fetchTemplates();
    } catch (err) {
      setTemplateActionError(err instanceof Error ? err.message : "Failed to duplicate template.");
    } finally {
      setDuplicatingId(null);
    }
  }

  async function handleToggleActive(template: TemplateSummary) {
    setTogglingId(template.id);
    setTemplateActionError(null);
    try {
      const res = await apiFetch(`${TEMPLATES_URL}/${template.id}/active`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !template.isActive })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to update template status (${res.status})`);
      }
      await fetchTemplates();
    } catch (err) {
      setTemplateActionError(err instanceof Error ? err.message : "Failed to update template status.");
    } finally {
      setTogglingId(null);
    }
  }

  async function executeDeleteTemplate() {
    if (!deleteConfirmTemplate) return;
    const template = deleteConfirmTemplate;
    setDeletingId(template.id);
    setTemplateActionError(null);
    try {
      const res = await apiFetch(`${TEMPLATES_URL}/${template.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to delete template (${res.status})`);
      }
      await fetchTemplates();
    } catch (err) {
      setTemplateActionError(err instanceof Error ? err.message : "Failed to delete template.");
    } finally {
      setDeletingId(null);
      setDeleteConfirmTemplate(null);
    }
  }

  function handleTestClick(template: TemplateSummary) {
    setTestingTemplate(template);
    setTestResult(null);
    setTestError(null);
    testFileInputRef.current?.click();
  }

  async function handleTestFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !testingTemplate) return;
    setTestingBusy(true);
    setTestError(null);
    setTestResult(null);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const parseRes = await apiFetch(PARSE_GRID_URL, { method: "POST", body: formData });
      if (!parseRes.ok) {
        const body = (await parseRes.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Upload failed (${parseRes.status})`);
      }
      const parsedFile = (await parseRes.json()) as ParseGridResponse;
      const previewRes = await apiFetch(PREVIEW_URL, {
        method: "POST",
        body: JSON.stringify({ sourceFileId: parsedFile.sourceFileId, templateId: testingTemplate.id })
      });
      if (!previewRes.ok) {
        const body = (await previewRes.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Preview failed (${previewRes.status})`);
      }
      setTestResult((await previewRes.json()) as PreviewResponse);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Failed to test this file against the template.");
    } finally {
      setTestingBusy(false);
      if (testFileInputRef.current) testFileInputRef.current.value = "";
    }
  }

  const totalSourceKg = useMemo(() => {
    if (!preview) return 0;
    return preview.preview.groups.reduce((sum, g) => sum + g.reconciliation.rawRowWeightKg, 0);
  }, [preview]);

  const totalImportKg = useMemo(() => {
    if (!preview) return 0;
    return preview.preview.groups.reduce((sum, g) => sum + g.reconciliation.recognizedSizeKg, 0);
  }, [preview]);

  const hasDoubleCountWarning = useMemo(
    () => (preview?.preview.validationIssues ?? []).some((i) => i.code === "possible_duplicate_weight_source"),
    [preview]
  );

  return (
    <div className="coming-soon-card csv-template-builder">
      <h2>CSV Import Template Builder</h2>
      <p>
        Upload any CSV export. If its layout matches a saved template, it&rsquo;s recognized automatically. Otherwise,
        map its cells visually below and save it as a reusable template for your organization.
      </p>

      {rateLimitNotice && (
        <div className="form-error csv-template-rate-limit-notice">
          <p>
            {rateLimitNotice.source === "save" ? <strong>Your template was NOT saved. </strong> : null}
            {rateLimitNotice.message}
          </p>
          <p>
            {rateLimitCountdown > 0
              ? `You can try again in ${rateLimitCountdown}s.`
              : "You can try again now."}
            {" "}
            {rateLimitNotice.source === "save"
              ? "Nothing was cleared — your mappings are exactly as you left them."
              : "The grid is unaffected — your mappings are unchanged."}
          </p>
          {rateLimitCountdown === 0 && (
            <button type="button" onClick={() => setRateLimitNotice(null)}>Dismiss</button>
          )}
        </div>
      )}

      {restoredNotice && (
        <div className="form-success csv-template-restored-notice">
          <p>Restored your in-progress mapping from your last session.</p>
          <button type="button" onClick={() => setRestoredNotice(false)}>Dismiss</button>
        </div>
      )}

      {saveSuccessMessage && (
        <div className="form-success csv-template-restored-notice">
          <p>&#10003; {saveSuccessMessage}</p>
          <button type="button" onClick={() => setSaveSuccessMessage(null)}>Dismiss</button>
        </div>
      )}

      <PendingCsvImportsSection
        items={pendingItems}
        loading={pendingLoading}
        error={pendingError}
        resumingPendingId={resumingPendingId}
        importingKey={importingKey}
        importStatus={importStatus}
        templates={templates}
        onSetUpTemplate={handleSetUpTemplateFromPending}
        onReprocessWithTemplate={handleReprocessPendingWithTemplate}
        onImportGroup={handleImportPendingGroup}
        onRefresh={fetchPendingItems}
      />

      <h3>{editingTemplateId ? `Editing "${editingTemplateName}"` : "Upload a new file"}</h3>
      {editingTemplateId && (
        <p>
          Upload a CSV matching this template&rsquo;s layout to load its current mappings for editing.{" "}
          <button type="button" onClick={() => { setEditingTemplateId(null); setEditingTemplateName(null); }}>
            Cancel editing
          </button>
        </p>
      )}
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

          {parsed.match.kind === "none" && <p>No saved template matches this layout. Map it visually below.</p>}
        </div>
      )}

      {isBuildingDraft && parsed && (
        <>
          <MappingLegend activeTool={activeTool} onSelectTool={setActiveTool} />

          <div className="csv-template-toolbar">
            <span className="csv-template-active-tool" style={swatchStyle(activeTool)}>
              Assigning: {MAPPING_TYPE_LABELS[activeTool]} — select cells or columns.
            </span>
            {activeTool === "packed_date" && (
              <label className="csv-template-inline-picker">
                Date format:
                <select value={packDateFormat} onChange={(e) => setPackDateFormat(e.target.value as DateFormat)}>
                  {DATE_FORMATS.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>
            )}
            <span className="csv-template-toolbar-spacer" />
            <button type="button" onClick={handleUndo} disabled={past.length === 0}>Undo</button>
            <button type="button" onClick={handleRedo} disabled={future.length === 0}>Redo</button>
            <button type="button" onClick={clearSelection} disabled={selection.size === 0}>Clear Selection</button>
            <button type="button" className="danger" onClick={requestClearAllMappings} disabled={columnAssignments.size === 0 && rowIgnoreSelections.size === 0}>
              Clear All Mappings
            </button>
          </div>
          {rowClickHint && <p className="form-error">{rowClickHint}</p>}
          {ignoreHint && <p className="form-error">{ignoreHint}</p>}

          <div className="csv-template-grid-wrapper" onMouseLeave={() => { isDraggingRef.current = false; }}>
            <table className="varieties-table csv-template-grid">
              <thead>
                <tr>
                  <th />
                  {parsed.grid[0]?.map((_, colIndex) => {
                    const assignment = columnAssignments.get(colIndex);
                    return (
                      <th
                        key={colIndex}
                        onClick={(e) => handleColumnHeaderClick(colIndex, e)}
                        style={assignment ? headerSwatchStyle(assignment) : undefined}
                        title="Click to assign the whole column; Ctrl/Cmd-click to add to a multi-column selection"
                      >
                        <div>{columnLetter(colIndex)}</div>
                        {assignment && <div className="csv-template-column-badge">{MAPPING_TYPE_LABELS[assignment]}</div>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {parsed.grid.slice(0, 500).map((row, rowIndex) => {
                  const isIgnoredRow = rowIgnoreSelections.has(rowIndex);
                  return (
                    <tr
                      key={rowIndex}
                      className={rowIndex === draft.headerRowIndex ? "csv-template-header-row" : undefined}
                      style={isIgnoredRow ? rowIgnoreStyle() : undefined}
                    >
                      <td
                        className="csv-template-row-controls"
                      >
                        <span
                          className="csv-template-row-number"
                          onClick={(e) => handleRowNumberClick(rowIndex, e)}
                          title='Click to exclude this row; only applies when "Ignore" is the active tool'
                        >
                          {rowIndex + 1}
                        </span>
                        <button type="button" onClick={() => setDraft((c) => ({ ...c, headerRowIndex: rowIndex }))} title="Set as header row">
                          H
                        </button>
                        <button type="button" onClick={() => setDraft((c) => ({ ...c, dataStartRowIndex: rowIndex }))} title="Set as first data row">
                          D
                        </button>
                      </td>
                      {row.map((cell, colIndex) => {
                        const isFixed = fixedCellKeys.has(`${rowIndex}:${colIndex}`);
                        const key = cellKey(rowIndex, colIndex);
                        const isSelected = selection.has(key);
                        const isFlashed = flashCells.has(key);
                        const assignment = columnAssignments.get(colIndex);
                        const isDataRow = dataRowIndexes.includes(rowIndex);
                        return (
                          <td
                            key={colIndex}
                            className={[
                              isFixed ? "csv-template-fixed-cell" : "",
                              isSelected ? "csv-template-cell-selected" : "",
                              isFlashed ? "csv-template-cell-flash" : ""
                            ].filter(Boolean).join(" ") || undefined}
                            style={isDataRow && assignment ? cellSwatchStyle(assignment) : undefined}
                            onMouseDown={isDataRow ? (e) => handleCellMouseDown(rowIndex, colIndex, e) : undefined}
                            onMouseEnter={isDataRow ? (e) => handleCellMouseEnter(rowIndex, colIndex, e) : undefined}
                            onMouseUp={isDataRow ? (e) => handleCellMouseUp(rowIndex, colIndex, e) : undefined}
                            onDoubleClick={() => {
                              const field = window.prompt(
                                `Use cell (row ${rowIndex + 1}, ${columnLetter(colIndex)}) as a fixed value for which field? (${MAPPED_FIELDS.join(", ")})`,
                                "variety"
                              ) as MappedField | null;
                              if (field && MAPPED_FIELDS.includes(field)) toggleFixedCell(rowIndex, colIndex, field);
                            }}
                            title={isDataRow ? "Click, drag, Ctrl/Cmd-click, or Shift-click to assign. Double-click to use as a fixed value." : undefined}
                          >
                            {cell}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="recent-entries-footer">
            Showing {Math.min(parsed.grid.length, 500)} of {parsed.rowCount} rows. Double-click any cell to use it as a
            fixed value instead of a whole column (for report-style files where a value like variety or date appears
            once above the table).
          </p>

          {visualIgnoreInference.rules.length > 0 && (
            <div className="csv-template-rules-preview">
              <h3>Rules that will be saved</h3>
              <ul>
                {visualIgnoreInference.rules.map((r) => (
                  <li key={`${r.columnIndex}-${r.value}`}>{plainLanguageIgnoreRule(r)}</li>
                ))}
              </ul>
            </div>
          )}
          {visualIgnoreInference.unresolvedRows.length > 0 && (
            <p className="form-error">
              {visualIgnoreInference.unresolvedRows.length} ignored row(s) don&rsquo;t match a consistent value pattern in
              any column, so they can&rsquo;t be safely reproduced on a future export. Row order can change between
              exports — pick a column/value to match on instead of relying on position.
            </p>
          )}

          {(uniqueValues.sizeLabels.length > 0 || uniqueValues.marketGrades.length > 0) && (
            <ValueMappingPanel
              sizeLabels={uniqueValues.sizeLabels}
              marketGrades={uniqueValues.marketGrades}
              valueMappings={draft.valueMappings}
              yieldSizes={yieldSizes}
              onChange={upsertValueMapping}
            />
          )}

          <div className="csv-template-advanced-toggle">
            <button type="button" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Hide" : "Show"} Advanced: Conditional Row Rules
            </button>
          </div>
          {showAdvanced && (
            <RuleEditor rules={draft.rules} yieldSizes={yieldSizes} onAdd={addRule} onUpdate={updateRule} onRemove={removeRule} />
          )}

          <div className="csv-template-save-row">
            <input
              type="text"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Template name (e.g. FlowMaster CSV Export)"
            />
            <button type="button" className="cases-entry-open-button" onClick={handleSaveClick} disabled={saving || !templateName.trim()}>
              {saving ? "Saving..." : editingTemplateId ? "Save new version" : "Save as template"}
            </button>
            {saveStatus && <span className="form-error">{saveStatus}</span>}
          </div>
        </>
      )}

      {previewLoading && <p>Building preview&hellip;</p>}
      {previewError && <p className="form-error">{previewError}</p>}

      {preview && (
        <>
          <MappedResultsPanel preview={preview.preview} totalSourceKg={totalSourceKg} totalImportKg={totalImportKg} hasDoubleCountWarning={hasDoubleCountWarning} />
          <PreviewPanel
            preview={preview.preview}
            layoutMismatch={preview.layoutMismatch}
            canImportOverall={Boolean(activeTemplateId)}
            importingKey={importingKey}
            importStatus={importStatus}
            onImport={handleImportGroup}
          />
        </>
      )}

      <input
        ref={testFileInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={handleTestFileChange}
      />

      <SavedTemplatesSection
        templates={templates}
        loading={templatesLoading}
        error={templatesError}
        actionError={templateActionError}
        highlightedId={highlightedTemplateId}
        duplicatingId={duplicatingId}
        togglingId={togglingId}
        deletingId={deletingId}
        testingBusy={testingBusy}
        testingTemplateId={testingTemplate?.id ?? null}
        onRefresh={fetchTemplates}
        onView={handleViewMappings}
        onTest={handleTestClick}
        onEdit={handleEditTemplate}
        onDuplicate={handleDuplicateTemplate}
        onToggleActive={handleToggleActive}
        onDeleteRequest={setDeleteConfirmTemplate}
      />

      {(viewingTemplate || viewingTemplateLoading || viewingTemplateError) && (
        <div className="modal-overlay">
          <div className="variety-modal csv-template-modal csv-template-mappings-modal">
            <h3>{viewingTemplate ? `${viewingTemplate.name} — mappings` : "Loading mappings…"}</h3>
            {viewingTemplateLoading && <p>Loading&hellip;</p>}
            {viewingTemplateError && <p className="form-error">{viewingTemplateError}</p>}
            {viewingTemplate && <TemplateMappingsView template={viewingTemplate} />}
            <div className="csv-template-modal-actions">
              <button type="button" onClick={() => { setViewingTemplate(null); setViewingTemplateError(null); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {(testingTemplate && (testingBusy || testResult || testError)) && (
        <div className="modal-overlay">
          <div className="variety-modal csv-template-modal csv-template-mappings-modal">
            <h3>Test &ldquo;{testingTemplate.name}&rdquo; with a CSV</h3>
            {testingBusy && <p>Uploading and building a preview&hellip;</p>}
            {testError && <p className="form-error">{testError}</p>}
            {testResult && (
              <>
                {testResult.layoutMismatch && (
                  <p className="form-error">This file&rsquo;s structure doesn&rsquo;t match the template. Review carefully.</p>
                )}
                {testResult.preview.validationIssues.length > 0 && (
                  <ul className="form-error csv-template-issue-list">
                    {testResult.preview.validationIssues.map((issue, i) => (
                      <li key={i}>{issue.message}</li>
                    ))}
                  </ul>
                )}
                {testResult.preview.groups.length === 0 && <p>No data rows were found.</p>}
                {testResult.preview.groups.map((group) => (
                  <div key={group.groupKey} className="csv-template-preview-group">
                    <h4>
                      {group.varietyRaw ?? "Unknown variety"} &middot; {group.packedDate ?? "Not recorded"}
                      {group.lotNumber ? ` · Lot ${group.lotNumber}` : ""}
                    </h4>
                    <table className="varieties-table">
                      <thead><tr><th>Size</th><th>kg</th></tr></thead>
                      <tbody>
                        {Object.entries(group.sizeKg).map(([name, kg]) => (
                          <tr key={name}><td>{name}</td><td>{kg.toFixed(2)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                    <p>
                      Recognized: {group.reconciliation.recognizedSizeKg.toFixed(2)} kg &middot; Ignored:{" "}
                      {group.reconciliation.ignoredKg.toFixed(2)} kg &middot; Unresolved: {group.reconciliation.unresolvedKg.toFixed(2)} kg
                    </p>
                  </div>
                ))}
              </>
            )}
            <div className="csv-template-modal-actions">
              <button type="button" onClick={() => { setTestingTemplate(null); setTestResult(null); setTestError(null); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmTemplate && (
        <div className="modal-overlay">
          <div className="variety-modal csv-template-modal">
            <h3>Delete &ldquo;{deleteConfirmTemplate.name}&rdquo;?</h3>
            <p>This cannot be undone. Templates that have been used for imports can&rsquo;t be deleted — disable them instead.</p>
            <div className="csv-template-modal-actions">
              <button type="button" onClick={() => setDeleteConfirmTemplate(null)}>Cancel</button>
              <button type="button" className="danger" onClick={() => void executeDeleteTemplate()} disabled={deletingId === deleteConfirmTemplate.id}>
                {deletingId === deleteConfirmTemplate.id ? "Deleting..." : "Delete Permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {nonTranslatableWarning && (
        <div className="modal-overlay">
          <div className="variety-modal csv-template-modal">
            <h3>Can&rsquo;t safely reproduce this selection</h3>
            <p>{nonTranslatableWarning}</p>
            <div className="csv-template-modal-actions">
              <button type="button" onClick={() => setNonTranslatableWarning(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {clearAllConfirm && (
        <div className="modal-overlay">
          <div className="variety-modal csv-template-modal">
            <h3>Clear all mappings?</h3>
            <p>This removes every column assignment and generated rule. This can be undone with Undo afterward.</p>
            <div className="csv-template-modal-actions">
              <button type="button" onClick={() => setClearAllConfirm(false)}>Cancel</button>
              <button type="button" className="danger" onClick={executeClearAllMappings}>Clear All Mappings</button>
            </div>
          </div>
        </div>
      )}

      {saveConfirm && (
        <div className="modal-overlay">
          <div className="variety-modal csv-template-modal">
            <h3>Review rules before saving</h3>
            {saveConfirm.rules.length > 0 && (
              <ul>
                {saveConfirm.rules.map((r) => (
                  <li key={`${r.columnIndex}-${r.value}`}>{plainLanguageIgnoreRule(r)}</li>
                ))}
              </ul>
            )}
            {saveConfirm.unresolvedRows.length > 0 && (
              <p className="form-error">
                {saveConfirm.unresolvedRows.length} ignored row(s) still don&rsquo;t match a consistent value pattern and
                won&rsquo;t be reliably excluded on future exports. Go back and pick a column/value to match on, or
                continue and accept this only applies to the current file.
              </p>
            )}
            <div className="csv-template-modal-actions">
              <button type="button" onClick={() => setSaveConfirm(null)}>Go back</button>
              <button type="button" className="cases-entry-open-button" onClick={() => void handleSaveTemplate()}>
                Confirm &amp; Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function swatchStyle(type: MappingType) {
  const c = MAPPING_TYPE_COLORS[type];
  return { background: c.bg, borderColor: c.border, color: c.text };
}

function headerSwatchStyle(type: MappingType) {
  const c = MAPPING_TYPE_COLORS[type];
  return { background: c.bg, color: c.text };
}

function cellSwatchStyle(type: MappingType) {
  const c = MAPPING_TYPE_COLORS[type];
  return { background: c.bg };
}

function rowIgnoreStyle() {
  const c = MAPPING_TYPE_COLORS.ignore;
  return { background: c.bg };
}

function MappingLegend({ activeTool, onSelectTool }: { activeTool: MappingType; onSelectTool: (t: MappingType) => void }) {
  return (
    <div className="csv-template-legend">
      <label htmlFor="csv-active-tool" className="csv-template-legend-label">
        Assign selected cells as
      </label>
      <select id="csv-active-tool" value={activeTool} onChange={(e) => onSelectTool(e.target.value as MappingType)}>
        {MAPPING_TYPES.map((t) => (
          <option key={t} value={t}>{MAPPING_TYPE_LABELS[t]}</option>
        ))}
      </select>
      <div className="csv-template-legend-chips">
        {MAPPING_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`csv-template-legend-chip${t === activeTool ? " csv-template-legend-chip-active" : ""}`}
            style={swatchStyle(t)}
            onClick={() => onSelectTool(t)}
          >
            {MAPPING_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

function MappedResultsPanel({
  preview,
  totalSourceKg,
  totalImportKg,
  hasDoubleCountWarning
}: {
  preview: NormalizedPreview;
  totalSourceKg: number;
  totalImportKg: number;
  hasDoubleCountWarning: boolean;
}) {
  const rows = preview.groups.flatMap((g) => g.rows.map((r) => ({ group: g, row: r })));
  if (rows.length === 0) return null;

  return (
    <div className="csv-template-mapped-results">
      <h3>Mapped results</h3>
      <p className={hasDoubleCountWarning ? "form-error" : undefined}>
        Total source kg: {totalSourceKg.toFixed(2)} &middot; Total import kg: {totalImportKg.toFixed(2)}
        {hasDoubleCountWarning && " — possible double-counting detected (see issues below). Saving is blocked until resolved."}
      </p>
      <div className="csv-template-mapped-results-scroll">
        <table className="varieties-table">
          <thead>
            <tr>
              <th>Variety</th>
              <th>Pack Date</th>
              <th>Lot Number</th>
              <th>Size Label</th>
              <th>Weight</th>
              <th>Ignored</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map(({ group, row }) => (
              <tr key={`${group.groupKey}-${row.rowIndex}`}>
                <td>{group.varietyRaw ?? "—"}</td>
                <td>{group.packedDate ?? "—"}</td>
                <td>{group.lotNumber ?? "—"}</td>
                <td>{row.sizeLabelRaw ?? "—"}</td>
                <td>{row.sizeWeightKg !== null ? row.sizeWeightKg.toFixed(3) : "—"}</td>
                <td>{row.action === "ignored" ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      <p className="recent-entries-footer">
        Rules generated by the visual tool above (prefixed automatically) also appear here and can be fine-tuned.
      </p>
      {rules.map((rule) => (
        <div key={rule.id} className="csv-template-rule-row">
          <span>#{rule.priority}</span>
          {rule.conditions.map((cond, condIndex) => (
            <span key={condIndex} className="csv-template-rule-condition">
              {cond.field ? (
                <select
                  value={cond.field}
                  onChange={(e) => {
                    const conditions = [...rule.conditions];
                    conditions[condIndex] = { field: e.target.value as MappedField, operator: cond.operator, value: cond.value };
                    onUpdate(rule.id, { conditions });
                  }}
                >
                  {MAPPED_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {FIELD_LABELS[f]}
                    </option>
                  ))}
                </select>
              ) : (
                <span title="Generated by the visual tool from a raw column, not one of the mapped fields">
                  Column {(cond.columnIndex ?? 0) + 1}
                </span>
              )}
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
  templates,
  onSetUpTemplate,
  onReprocessWithTemplate,
  onImportGroup,
  onRefresh
}: {
  items: PendingCsvItem[];
  loading: boolean;
  error: string | null;
  resumingPendingId: string | null;
  importingKey: string | null;
  importStatus: Record<string, string>;
  templates: TemplateSummary[];
  onSetUpTemplate: (item: PendingCsvItem) => void;
  onReprocessWithTemplate: (item: PendingCsvItem, templateId: string) => void;
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
              <div className="csv-template-saved-actions">
                <button
                  type="button"
                  className="cases-entry-open-button"
                  disabled={resumingPendingId === item.id || !item.sourceFileId}
                  onClick={() => onSetUpTemplate(item)}
                >
                  {resumingPendingId === item.id ? "Loading..." : "Set up CSV Template"}
                </button>
                {templates.length > 0 && item.sourceFileId && (
                  <label>
                    Reprocess with saved template:{" "}
                    <select
                      defaultValue=""
                      disabled={resumingPendingId === item.id}
                      onChange={(e) => {
                        if (e.target.value) onReprocessWithTemplate(item, e.target.value);
                        e.target.value = "";
                      }}
                    >
                      <option value="" disabled>Select a template&hellip;</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
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

function templateBadgeStyle(isActive: boolean): CSSProperties {
  return isActive
    ? { display: "inline-block", borderRadius: 999, padding: "0.1rem 0.5rem", fontSize: "0.72rem", background: "#e8f8ef", color: "#1f7a42", border: "1px solid #bfe9cf" }
    : { display: "inline-block", borderRadius: 999, padding: "0.1rem 0.5rem", fontSize: "0.72rem", background: "#f9eaea", color: "#8f2d1f", border: "1px solid #f0c5be" };
}

function SavedTemplatesSection({
  templates,
  loading,
  error,
  actionError,
  highlightedId,
  duplicatingId,
  togglingId,
  deletingId,
  testingBusy,
  testingTemplateId,
  onRefresh,
  onView,
  onTest,
  onEdit,
  onDuplicate,
  onToggleActive,
  onDeleteRequest
}: {
  templates: TemplateSummary[];
  loading: boolean;
  error: string | null;
  actionError: string | null;
  highlightedId: string | null;
  duplicatingId: string | null;
  togglingId: string | null;
  deletingId: string | null;
  testingBusy: boolean;
  testingTemplateId: string | null;
  onRefresh: () => void;
  onView: (t: TemplateSummary) => void;
  onTest: (t: TemplateSummary) => void;
  onEdit: (t: TemplateSummary) => void;
  onDuplicate: (t: TemplateSummary) => void;
  onToggleActive: (t: TemplateSummary) => void;
  onDeleteRequest: (t: TemplateSummary) => void;
}) {
  return (
    <div className="csv-template-pending-section csv-template-saved-section">
      <div className="csv-template-pending-header">
        <h3>Saved CSV Templates</h3>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {actionError && <p className="form-error">{actionError}</p>}
      {!loading && templates.length === 0 && !error && <p>No saved templates yet — build one above and it will appear here.</p>}

      {templates.map((t) => (
        <div key={t.id} className={`csv-template-pending-card${t.id === highlightedId ? " csv-template-cell-flash" : ""}`}>
          <div className="csv-template-pending-card-header">
            <strong>{t.name}</strong>
            <span style={templateBadgeStyle(t.isActive)}>{t.isActive ? "Active" : "Disabled"}</span>
          </div>
          <p>
            Version {t.version} &middot; {t.layoutSummary}
          </p>
          <p>
            {t.mappedFieldsCount} mapped field{t.mappedFieldsCount === 1 ? "" : "s"} &middot; {t.rulesCount} rule{t.rulesCount === 1 ? "" : "s"} &middot;{" "}
            {t.valueMappingsCount} value mapping{t.valueMappingsCount === 1 ? "" : "s"}
          </p>
          <p className="recent-entries-footer">
            Created {formatUploadedAt(t.createdAt)} by {t.createdByName} &middot; Updated {formatUploadedAt(t.updatedAt)} by {t.updatedByName}
          </p>
          <div className="csv-template-saved-actions">
            <button type="button" onClick={() => onView(t)}>View mappings</button>
            <button type="button" onClick={() => onTest(t)} disabled={testingBusy && testingTemplateId === t.id}>
              {testingBusy && testingTemplateId === t.id ? "Testing..." : "Test with a CSV"}
            </button>
            <button type="button" onClick={() => onEdit(t)}>Edit</button>
            <button type="button" onClick={() => onDuplicate(t)} disabled={duplicatingId === t.id}>
              {duplicatingId === t.id ? "Duplicating..." : "Duplicate"}
            </button>
            <button type="button" onClick={() => onToggleActive(t)} disabled={togglingId === t.id}>
              {togglingId === t.id ? "Updating..." : t.isActive ? "Disable" : "Enable"}
            </button>
            <button type="button" className="danger" onClick={() => onDeleteRequest(t)} disabled={deletingId === t.id}>
              {deletingId === t.id ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function TemplateMappingsView({ template }: { template: TemplateDetail }) {
  return (
    <div className="csv-template-mappings-view">
      <p>
        Version {template.version} &middot; {template.layoutSummary} &middot; <span style={templateBadgeStyle(template.isActive)}>{template.isActive ? "Active" : "Disabled"}</span>
      </p>
      <p className="recent-entries-footer">
        Created {formatUploadedAt(template.createdAt)} by {template.createdByName} &middot; Updated {formatUploadedAt(template.updatedAt)} by {template.updatedByName}
      </p>

      <h4>Column mappings</h4>
      <table className="varieties-table">
        <thead>
          <tr><th>Column</th><th>Field</th></tr>
        </thead>
        <tbody>
          {template.columnMappings.map((m) => (
            <tr key={m.columnIndex}>
              <td>{columnLetter(m.columnIndex)}</td>
              <td>{TEMPLATE_FIELD_LABELS[m.field] ?? m.field}{m.dateFormat ? ` (${m.dateFormat})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {template.fixedCellMappings.length > 0 && (
        <>
          <h4>Fixed cell mappings</h4>
          <table className="varieties-table">
            <thead>
              <tr><th>Cell</th><th>Field</th></tr>
            </thead>
            <tbody>
              {template.fixedCellMappings.map((m, i) => (
                <tr key={i}>
                  <td>{columnLetter(m.columnIndex)}{m.rowIndex + 1}</td>
                  <td>{TEMPLATE_FIELD_LABELS[m.field] ?? m.field}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4>Size &amp; Market/Grade values ({template.valueMappings.length})</h4>
      {template.valueMappings.length === 0 ? (
        <p>None configured.</p>
      ) : (
        <table className="varieties-table">
          <thead>
            <tr><th>Raw value</th><th>Field</th><th>Action</th></tr>
          </thead>
          <tbody>
            {template.valueMappings.map((v, i) => (
              <tr key={i}>
                <td>{v.rawValue}</td>
                <td>{v.sourceField}</td>
                <td>{v.action}{v.newSizeName ? `: ${v.newSizeName}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Conditional row rules ({template.rules.length})</h4>
      {template.rules.length === 0 ? (
        <p>None configured.</p>
      ) : (
        template.rules.map((r) => (
          <p key={r.id}>
            #{r.priority}: {r.conditionLogic === "AND" ? "when all of" : "when any of"}{" "}
            {r.conditions
              .map((c) => `${c.field ? (TEMPLATE_FIELD_LABELS[c.field] ?? c.field) : `Column ${(c.columnIndex ?? 0) + 1}`} ${c.operator} ${c.value ?? ""}`)
              .join("; ")}{" "}
            &rarr; {r.action}
          </p>
        ))
      )}
    </div>
  );
}
