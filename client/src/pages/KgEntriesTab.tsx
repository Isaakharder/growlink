import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";

type YieldSizeStatus = "active" | "inactive";
type VarietyStatus = "active" | "inactive";
type VarietyColor = "red" | "orange" | "yellow" | "green";

type VarietyOption = {
  id: string;
  name: string;
  area_m2: number;
  case_kg: number;
  status: VarietyStatus;
  color: VarietyColor;
};

type YieldSizeOption = {
  id: string;
  name: string;
  sort_order: number;
  status: YieldSizeStatus;
};

type DailyBreakdown = {
  id: string;
  packed_date: string | null;
  size_kg: Record<string, number>;
  total_kg: number;
};

type YieldEntry = {
  id: string;
  variety_id: string;
  variety_name: string;
  year: number;
  week: number;
  packed_date: string | null;
  size_kg: Record<string, number>;
  total_kg: number;
  average_fruit_weight_g: number | null;
  kg_per_m2: number;
  total_cases: number;
  created_at: string;
  updated_at: string;
  daily_breakdowns: DailyBreakdown[];
};

type RecentEntriesResponse = {
  entries: YieldEntry[];
  nextCursor: string | null;
  hasMore: boolean;
};

type YieldEntryFormState = {
  variety_id: string;
  year: string;
  week: string;
  packed_date: string;
  average_fruit_weight_g: string;
  size_kg: Record<string, string>;
};

type WeekOption = {
  value: number;
  label: string;
};

const OPTIONS_URL = "/api/yield-entry-options";
const ENTRIES_URL = "/api/yield-entries";
const RECENT_ENTRIES_URL = "/api/yield-entries/recent";
const RECENT_ENTRIES_INITIAL_LIMIT = 7;
const RECENT_ENTRIES_PAGE_LIMIT = 25;
const PDF_PREVIEW_URL = "/api/pdf-import/preview";
const PDF_IMPORT_URL = "/api/pdf-import/import";
const PDF_REMAP_SIZES_URL = "/api/pdf-import/remap-sizes";
const SIZE_RULES_URL = "/api/flowmaster-size-rules";
const YIELD_SIZES_URL = "/api/yield-sizes";
const PENDING_IMPORTS_URL = "/api/agent-pending-imports";
const FLOWMASTER_FILTER = "?dataSourceType=flowmaster";
const CSV_SETTINGS_URL = "/api/greenhouse-setup/csv-size-settings";
const CSV_TEMPLATES_URL = "/api/csv-templates";
const CSV_TEMPLATE_PREVIEW_URL = "/api/csv-templates/preview";
const CSV_TEMPLATE_IMPORT_URL = "/api/csv-templates/import";

type CsvSizeEntry = {
  rawLabel: string;
  mappedSizeName: string | null;
  kg: number;
};

// ---------------------------------------------------------------------------
// CSV files uploaded through this same "PDF / CSV Upload" button are routed
// server-side through the generic CSV Template Builder engine (never the
// legacy FlowMaster CSV parser) — see server/src/routes/pdfImport.ts's
// previewCsvFileForKgEntries. These types mirror that response shape.
// ---------------------------------------------------------------------------

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

type CsvTemplateSummary = { id: string; name: string; version: number; isActive: boolean; isCurrent: boolean };

type CsvTemplateManualUploadItem =
  | { filename: string; success: true; source: "csv_template"; kind: "exact"; sourceFileId: string; templateId: string; templateName: string; templateVersion: number; preview: NormalizedPreview }
  | { filename: string; success: true; source: "csv_template"; kind: "ambiguous"; sourceFileId: string; candidates: Array<{ id: string; name: string; version: number }> }
  | { filename: string; success: true; source: "csv_template"; kind: "close"; sourceFileId: string; closestTemplateId: string; closestTemplateName: string; similarity: number | null; pendingImportId: string }
  | { filename: string; success: true; source: "csv_template"; kind: "none"; sourceFileId: string; pendingImportId: string }
  | { filename: string; success: false; source: "csv_template"; error: { message: string } };

type PdfPreviewFileSuccess = {
  id?: string;
  filename: string;
  success: true;
  lotNumber: string | null;
  alreadyImported: boolean;
  skipped: boolean;
  variety: string | null;
  overrideVarietyId?: string | null;
  isOverridden?: boolean;
  matchedVariety: {
    found: boolean;
    varietyId: string | null;
    varietyName: string | null;
  };
  startTime: string | null;
  startDate: string | null;
  isoWeek: number | null;
  isoYear: number | null;
  totalKg: number | null;
  averageFruitWeightG: number | null;
  sizeBreakdown: Record<string, number>;
  sizeMappingStatus: {
    mappedCount: number;
    unmappedCount: number;
    mapped: Array<{
      pdfSize: string;
      growlinkSize: string;
    }>;
    unmapped: string[];
  };
  duplicateStatus: {
    found: boolean;
  };
  unknownSizes: string[];
  warnings: string[];
  csvSizes: CsvSizeEntry[];
};

type PdfPreviewFileFailure = {
  filename: string;
  success: false;
  error: {
    message: string;
  };
};

type PdfPreviewFile = PdfPreviewFileSuccess | PdfPreviewFileFailure;

type GroupedPdfPreviewCard = {
  key: string;
  matchedVarietyId: string | null;
  varietyName: string;
  isoWeek: number | null;
  isoYear: number | null;
  sourceFiles: string[];
  sourceReadings: Array<{
    id: string | null;
    filename: string;
    lotNumber: string | null;
    startDate: string | null;
    startTime: string | null;
    printedTotalKg: number | null;
    computedTotalKg: number;
    skipped: boolean;
    skipReason: string | null;
    originalVarietyName: string | null;
    isOverridden: boolean;
  }>;
  totalKg: number;
  averageFruitWeightG: number | null;
  printedTotalKg: number | null;
  sizeBreakdown: Record<string, number>;
  warnings: string[];
  unknownSizes: string[];
  hasMatchedVariety: boolean;
  duplicateFound: boolean;
  mappedCount: number;
  unmappedCount: number;
  hasImportableReadings: boolean;
  csvSizes: CsvSizeEntry[];
  isCsvSource: boolean;
};

type PendingAgentWeek = {
  isoYear: number | null;
  isoWeek: number | null;
  count: number;
};

type SizeRuleAction = "create" | "map" | "ignore" | "distribute";

type FlowMasterSizeRule = {
  id: string;
  raw_label: string;
  action: SizeRuleAction;
  target_size_id: string | null;
  distribute_size_ids: string[];
};

type SizeSetupDraft = {
  action: SizeRuleAction;
  newSizeName: string;
  newSizeSortOrder: string;
  mapTargetId: string;
  distributeIds: string[];
};

function defaultSizeSetupDraft(label: string): SizeSetupDraft {
  return {
    action: "create",
    newSizeName: label,
    newSizeSortOrder: "0",
    mapTargetId: "",
    distributeIds: []
  };
}

function isSizeRelatedWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return (
    warning.startsWith("New size found:") ||
    lower.includes("saved size rule") ||
    lower.includes("saved distribution rule")
  );
}

function hasUnresolvedSizes(files: PdfPreviewFile[]): boolean {
  return files.some((file) => file.success && !file.skipped && file.unknownSizes.length > 0);
}

const KNOWN_SIZE_ORDER = ["Small", "Medium", "Large", "SXL", "XL", "XXL"];

function getWeekStartSunday(year: number, week: number) {
  const jan1 = new Date(year, 0, 1);
  const start = new Date(jan1);
  start.setDate(jan1.getDate() - jan1.getDay() + (week - 1) * 7);
  return start;
}

function formatMonthDay(date: Date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit"
  });
}

function createWeekOptions(year: number): WeekOption[] {
  const options: WeekOption[] = [];

  for (let week = 1; week <= 53; week += 1) {
    const start = getWeekStartSunday(year, week);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);

    options.push({
      value: week,
      label: `Week ${week} - ${formatMonthDay(start)} to ${formatMonthDay(end)}`
    });
  }

  return options;
}

function getCurrentWeek(year: number) {
  const now = new Date();
  const jan1 = new Date(year, 0, 1);
  const weekOneStart = new Date(jan1);
  weekOneStart.setDate(jan1.getDate() - jan1.getDay());

  const diffMs = now.getTime() - weekOneStart.getTime();
  const week = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;

  return Math.min(Math.max(week, 1), 53);
}

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function numberOrZero(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortSizeNames(a: string, b: string): number {
  const ia = KNOWN_SIZE_ORDER.indexOf(a);
  const ib = KNOWN_SIZE_ORDER.indexOf(b);

  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b);
}

// sizeBreakdown keys include BOTH resolved GrowLink size names and any raw
// labels still awaiting a saved rule (see unknownSizes) — summing every key
// overstates a source reading's importable kg by including kg that isn't
// actually mapped to a real size yet. Excluding unknownSizes keys gives the
// correct "mapped/importable kg" figure shown per Source Reading and rolled
// up into "Total kg from sizes".
function calculateMappedTotalKg(sizeBreakdown: Record<string, number>, unknownSizes: string[]): number {
  const unknownSet = new Set(unknownSizes);
  return Object.entries(sizeBreakdown).reduce(
    (sum, [size, kg]) => (unknownSet.has(size) ? sum : sum + kg),
    0
  );
}

export function KgEntriesTab() {
  const currentYear = new Date().getFullYear();
  const [varieties, setVarieties] = useState<VarietyOption[]>([]);
  const [yieldSizes, setYieldSizes] = useState<YieldSizeOption[]>([]);
  // Entries scoped to the currently selected form.year/form.week — used for
  // the weekly color-share summary and the duplicate-week-entry check.
  // Deliberately NOT the full org history: see recentEntries below.
  const [weekEntries, setWeekEntries] = useState<YieldEntry[]>([]);
  // Cursor-paginated "Recent Entries" table state. loadedRecentEntries grows
  // as "Show more entries" is clicked; recentEntriesCollapsed toggles
  // between showing just the newest 7 and the full loaded list so
  // "Show less" doesn't need to discard already-fetched data.
  const [loadedRecentEntries, setLoadedRecentEntries] = useState<YieldEntry[]>([]);
  const [recentEntriesCursor, setRecentEntriesCursor] = useState<string | null>(null);
  const [recentEntriesHasMore, setRecentEntriesHasMore] = useState(false);
  const [recentEntriesCollapsed, setRecentEntriesCollapsed] = useState(true);
  const [recentEntriesLoadingMore, setRecentEntriesLoadingMore] = useState(false);
  const [recentEntriesError, setRecentEntriesError] = useState<string | null>(null);
  const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pendingAppend, setPendingAppend] = useState<{
    varietyName: string;
    week: number;
    year: number;
    payload: {
      variety_id: string;
      year: number;
      week: number;
      packed_date: string | null;
      size_kg: Record<string, number>;
      average_fruit_weight_g: number | null;
    };
  } | null>(null);
  const [isPdfPreviewOpen, setIsPdfPreviewOpen] = useState(false);
  const [pdfPreviewUploading, setPdfPreviewUploading] = useState(false);
  const [pdfPreviewError, setPdfPreviewError] = useState<string | null>(null);
  const [pdfPreviewFiles, setPdfPreviewFiles] = useState<PdfPreviewFile[]>([]);
  const [pdfImportAllRunning, setPdfImportAllRunning] = useState(false);
  const [pdfImportStatus, setPdfImportStatus] = useState<string | null>(null);
  const [pdfImportedCardKeys, setPdfImportedCardKeys] = useState<Set<string>>(new Set());
  const [pdfCardImportingKeys, setPdfCardImportingKeys] = useState<Set<string>>(new Set());
  const [pdfCardImportErrors, setPdfCardImportErrors] = useState<Record<string, string>>({});
  const [csvTemplateFiles, setCsvTemplateFiles] = useState<CsvTemplateManualUploadItem[]>([]);
  const [csvTemplateOptions, setCsvTemplateOptions] = useState<CsvTemplateSummary[]>([]);
  const [csvTemplateOverrides, setCsvTemplateOverrides] = useState<Record<string, string>>({});
  const [csvTemplateRecomputing, setCsvTemplateRecomputing] = useState<Set<string>>(new Set());
  const [csvTemplateImportingKey, setCsvTemplateImportingKey] = useState<string | null>(null);
  const [csvTemplateImportStatus, setCsvTemplateImportStatus] = useState<Record<string, string>>({});
  const [pendingWeeks, setPendingWeeks] = useState<PendingAgentWeek[]>([]);
  const [csvIgnoredLabels, setCsvIgnoredLabels] = useState<string[]>([]);
  // Set only when pdfPreviewFiles was populated from GET /agent-pending-imports
  // (handlePendingWeekClick) rather than a fresh /pdf-import/preview upload —
  // lets handleCsvSizeToggle re-fetch server-truth (rules-aware) results
  // instead of relying on the client-side raw-label-only recompute, which
  // doesn't know about saved flowmaster_size_rules.
  const [viewedPendingWeek, setViewedPendingWeek] = useState<{ isoYear: number | null; isoWeek: number | null } | null>(null);
  const [reassigningReadingId, setReassigningReadingId] = useState<string | null>(null);
  const [reassignTargetVarietyId, setReassignTargetVarietyId] = useState<string>("");
  const [reassignSavingId, setReassignSavingId] = useState<string | null>(null);
  const [reassignErrors, setReassignErrors] = useState<Record<string, string>>({});
  const [removingReadingId, setRemovingReadingId] = useState<string | null>(null);
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});
  const [removeReadingConfirm, setRemoveReadingConfirm] = useState<{ readingId: string; filename: string } | null>(null);
  const [sizeRules, setSizeRules] = useState<FlowMasterSizeRule[]>([]);
  const [isSizeSetupOpen, setIsSizeSetupOpen] = useState(false);
  const [sizeSetupDrafts, setSizeSetupDrafts] = useState<Record<string, SizeSetupDraft>>({});
  const [sizeSetupSavingLabel, setSizeSetupSavingLabel] = useState<string | null>(null);
  const [sizeSetupErrors, setSizeSetupErrors] = useState<Record<string, string>>({});
  const [sizeSetupResolvedLabels, setSizeSetupResolvedLabels] = useState<Set<string>>(new Set());
  const [sizeSetupExiting, setSizeSetupExiting] = useState(false);
  const pdfFileInputRef = useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<YieldEntryFormState>({
    variety_id: "",
    year: String(currentYear),
    week: String(getCurrentWeek(currentYear)),
    packed_date: localIsoDate(new Date()),
    average_fruit_weight_g: "",
    size_kg: {}
  });

  const selectedVariety = useMemo(
    () => varieties.find((variety) => variety.id === form.variety_id),
    [form.variety_id, varieties]
  );

  const weekOptions = useMemo(() => createWeekOptions(Number(form.year)), [form.year]);

  const totalKg = useMemo(
    () => Object.values(form.size_kg).reduce((sum, value) => sum + numberOrZero(value), 0),
    [form.size_kg]
  );

  const kgPerM2 = useMemo(() => {
    if (!selectedVariety || selectedVariety.area_m2 <= 0) {
      return null;
    }
    return totalKg / selectedVariety.area_m2;
  }, [selectedVariety, totalKg]);

  const totalCases = useMemo(() => {
    if (!selectedVariety || selectedVariety.case_kg <= 0) {
      return 0;
    }
    return totalKg / selectedVariety.case_kg;
  }, [selectedVariety, totalKg]);

  function resetSizeKgFields(sizes: YieldSizeOption[]) {
    const next: Record<string, string> = {};
    for (const size of sizes) {
      next[size.id] = "0";
    }
    return next;
  }

  async function fetchOptionsAndEntries() {
    setLoading(true);
    setError(null);

    try {
      const optionsResponse = await apiFetch(OPTIONS_URL);

      if (!optionsResponse.ok) {
        throw new Error(`Failed to load entry options (${optionsResponse.status})`);
      }

      const optionsData = (await optionsResponse.json()) as {
        varieties: VarietyOption[];
        yieldSizes: YieldSizeOption[];
      };

      const sortedSizes = [...optionsData.yieldSizes].sort(
        (a, b) => a.sort_order - b.sort_order
      );

      setVarieties(optionsData.varieties);
      setYieldSizes(sortedSizes);

      setForm((current) => {
        const hasCurrentVariety = optionsData.varieties.some(
          (variety) => variety.id === current.variety_id
        );

        return {
          ...current,
          variety_id: hasCurrentVariety
            ? current.variety_id
            : (optionsData.varieties[0]?.id ?? ""),
          size_kg: Object.keys(current.size_kg).length
            ? {
                ...resetSizeKgFields(sortedSizes),
                ...current.size_kg
              }
            : resetSizeKgFields(sortedSizes)
        };
      });
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to load data entry options"
      );
    } finally {
      setLoading(false);
    }
  }

  // Scoped to a single variety-independent year/week so the weekly
  // color-share summary and the duplicate-entry check never need the full
  // organization history.
  async function fetchWeekEntries(year: number, week: number) {
    try {
      const res = await apiFetch(`${ENTRIES_URL}?year=${year}&week=${week}`);
      if (!res.ok) return;
      const data = (await res.json()) as YieldEntry[];
      setWeekEntries(data);
    } catch {
      // Non-critical — the weekly summary/duplicate check will just retry next time.
    }
  }

  async function checkExistingWeekEntry(
    varietyId: string,
    year: number,
    week: number
  ): Promise<YieldEntry | null> {
    try {
      const res = await apiFetch(`${ENTRIES_URL}?year=${year}&week=${week}`);
      if (!res.ok) return null;
      const data = (await res.json()) as YieldEntry[];
      return data.find((e) => e.variety_id === varietyId) ?? null;
    } catch {
      return null;
    }
  }

  // Re-fetches the Recent Entries table from the top, sized to whatever was
  // already loaded (at least the initial 7) so a create/update/delete is
  // reflected immediately without ever pulling the full org history.
  async function refreshRecentEntries() {
    const limit = Math.max(loadedRecentEntries.length, RECENT_ENTRIES_INITIAL_LIMIT);

    try {
      const res = await apiFetch(`${RECENT_ENTRIES_URL}?limit=${limit}`);
      if (!res.ok) return;
      const body = (await res.json()) as RecentEntriesResponse;
      setLoadedRecentEntries(body.entries);
      setRecentEntriesCursor(body.nextCursor);
      setRecentEntriesHasMore(body.hasMore);
    } catch {
      // Non-critical — the table simply keeps showing its last known state.
    }
  }

  async function fetchInitialRecentEntries() {
    setRecentEntriesError(null);

    try {
      const res = await apiFetch(`${RECENT_ENTRIES_URL}?limit=${RECENT_ENTRIES_INITIAL_LIMIT}`);
      if (!res.ok) {
        throw new Error(`Failed to load recent entries (${res.status})`);
      }
      const body = (await res.json()) as RecentEntriesResponse;
      setLoadedRecentEntries(body.entries);
      setRecentEntriesCursor(body.nextCursor);
      setRecentEntriesHasMore(body.hasMore);
      setRecentEntriesCollapsed(true);
    } catch (fetchError) {
      setRecentEntriesError(
        fetchError instanceof Error ? fetchError.message : "Failed to load recent entries"
      );
    }
  }

  async function handleShowMoreEntries() {
    // Already-loaded rows just need to be revealed — no network round trip.
    if (recentEntriesCollapsed && loadedRecentEntries.length > RECENT_ENTRIES_INITIAL_LIMIT) {
      setRecentEntriesCollapsed(false);
      return;
    }

    if (!recentEntriesHasMore) {
      return;
    }

    setRecentEntriesError(null);
    setRecentEntriesLoadingMore(true);

    try {
      const cursorParam = recentEntriesCursor ? `&cursor=${encodeURIComponent(recentEntriesCursor)}` : "";
      const res = await apiFetch(`${RECENT_ENTRIES_URL}?limit=${RECENT_ENTRIES_PAGE_LIMIT}${cursorParam}`);
      if (!res.ok) {
        throw new Error(`Failed to load more entries (${res.status})`);
      }
      const body = (await res.json()) as RecentEntriesResponse;
      setLoadedRecentEntries((current) => [...current, ...body.entries]);
      setRecentEntriesCursor(body.nextCursor);
      setRecentEntriesHasMore(body.hasMore);
      setRecentEntriesCollapsed(false);
    } catch (fetchError) {
      setRecentEntriesError(
        fetchError instanceof Error ? fetchError.message : "Failed to load more entries"
      );
    } finally {
      setRecentEntriesLoadingMore(false);
    }
  }

  function handleShowLessEntries() {
    setRecentEntriesCollapsed(true);
  }

  async function fetchPendingWeeks() {
    try {
      const res = await apiFetch(`${PENDING_IMPORTS_URL}${FLOWMASTER_FILTER}`);
      if (!res.ok) return;
      const body = (await res.json()) as { weeks?: PendingAgentWeek[] };
      setPendingWeeks(body.weeks ?? []);
    } catch {
      // Non-critical — week cards simply won't appear if this fails.
    }
  }

  async function fetchCsvSettings() {
    try {
      const res = await apiFetch(CSV_SETTINGS_URL);
      if (!res.ok) return;
      const body = (await res.json()) as { ignoredSizeLabels?: string[] };
      setCsvIgnoredLabels(body.ignoredSizeLabels ?? []);
    } catch {
      // Non-critical — checkboxes default to all included if this fails.
    }
  }

  async function fetchSizeRules() {
    try {
      const res = await apiFetch(SIZE_RULES_URL);
      if (!res.ok) return;
      const data = (await res.json()) as FlowMasterSizeRule[];
      setSizeRules(data);
    } catch {
      // Non-critical — setup UI just won't show which labels already have a saved rule.
    }
  }

  async function fetchActiveYieldSizes() {
    try {
      const res = await apiFetch(OPTIONS_URL);
      if (!res.ok) return;
      const body = (await res.json()) as { yieldSizes?: YieldSizeOption[] };
      const sortedSizes = [...(body.yieldSizes ?? [])].sort((a, b) => a.sort_order - b.sort_order);
      setYieldSizes(sortedSizes);
    } catch {
      // Non-critical — setup UI dropdowns simply won't include the just-created size until retried.
    }
  }

  // Re-resolves already-parsed preview files against the org's current
  // active sizes + saved rules, without needing the original file bytes
  // (the client never retains those past the initial upload). Falls back to
  // returning the input unchanged on any failure so the preview never loses
  // data — the user can just retry from the "Configure Sizes" button.
  async function remapPdfPreviewSizes(files: PdfPreviewFile[]): Promise<PdfPreviewFile[]> {
    const eligibleIndexes: number[] = [];
    const requestFiles: Array<{ sizeBreakdown: Record<string, number>; unknownSizes: string[] }> = [];

    files.forEach((file, index) => {
      if (file.success && !file.skipped) {
        eligibleIndexes.push(index);
        requestFiles.push({ sizeBreakdown: file.sizeBreakdown, unknownSizes: file.unknownSizes });
      }
    });

    if (requestFiles.length === 0) {
      return files;
    }

    try {
      const response = await apiFetch(PDF_REMAP_SIZES_URL, {
        method: "POST",
        body: JSON.stringify({ files: requestFiles })
      });

      if (!response.ok) {
        return files;
      }

      const body = (await response.json()) as {
        success: boolean;
        files?: Array<{
          sizeBreakdown: Record<string, number>;
          sizeMappingStatus: PdfPreviewFileSuccess["sizeMappingStatus"];
          unknownSizes: string[];
          sizeWarnings: string[];
        }>;
      };

      if (!body.success || !Array.isArray(body.files)) {
        return files;
      }

      const next = [...files];
      eligibleIndexes.forEach((fileIndex, i) => {
        const original = next[fileIndex];
        const result = body.files?.[i];
        if (!original.success || !result) return;

        const keptWarnings = original.warnings.filter((w) => !isSizeRelatedWarning(w));

        next[fileIndex] = {
          ...original,
          sizeBreakdown: result.sizeBreakdown,
          sizeMappingStatus: result.sizeMappingStatus,
          unknownSizes: result.unknownSizes,
          warnings: Array.from(new Set([...keptWarnings, ...result.sizeWarnings]))
        };
      });

      return next;
    } catch {
      return files;
    }
  }

  // Leaving the size setup workflow (either "Done"/auto-complete or
  // "Cancel") always re-resolves the preview against whatever rules were
  // saved so far, then returns to the preview modal — partial progress is
  // never lost, and any label still without a rule stays blocked.
  async function handleExitSizeSetup() {
    setSizeSetupExiting(true);
    try {
      const remapped = await remapPdfPreviewSizes(pdfPreviewFiles);
      setPdfPreviewFiles(remapped);
    } finally {
      setSizeSetupExiting(false);
      setIsSizeSetupOpen(false);
      setSizeSetupDrafts({});
      setSizeSetupErrors({});
      setSizeSetupResolvedLabels(new Set());
    }
  }

  async function handleSaveSizeSetupRow(label: string) {
    const draft = sizeSetupDrafts[label] ?? defaultSizeSetupDraft(label);

    setSizeSetupErrors((current) => {
      const next = { ...current };
      delete next[label];
      return next;
    });

    if (draft.action === "create" && !draft.newSizeName.trim()) {
      setSizeSetupErrors((current) => ({ ...current, [label]: "Size name is required." }));
      return;
    }
    if (draft.action === "map" && !draft.mapTargetId) {
      setSizeSetupErrors((current) => ({ ...current, [label]: "Select an existing size to map to." }));
      return;
    }
    if (draft.action === "distribute" && draft.distributeIds.length === 0) {
      setSizeSetupErrors((current) => ({ ...current, [label]: "Select at least one destination size." }));
      return;
    }

    setSizeSetupSavingLabel(label);

    try {
      let targetSizeId: string | null = null;

      if (draft.action === "create") {
        const sortOrderNum = Number(draft.newSizeSortOrder);
        const createResponse = await apiFetch(YIELD_SIZES_URL, {
          method: "POST",
          body: JSON.stringify({
            name: draft.newSizeName.trim(),
            sort_order: Number.isFinite(sortOrderNum) ? sortOrderNum : 0,
            status: "active"
          })
        });

        if (!createResponse.ok) {
          let message = "Failed to create size.";
          try {
            const body = (await createResponse.json()) as { message?: string };
            if (body.message) message = body.message;
          } catch {
            // Ignore non-JSON error body.
          }
          throw new Error(message);
        }

        const created = (await createResponse.json()) as YieldSizeOption;
        targetSizeId = created.id;
      } else if (draft.action === "map") {
        targetSizeId = draft.mapTargetId;
      }

      const rulePayload: Record<string, unknown> = {
        raw_label: label,
        action: draft.action
      };
      if (draft.action === "create" || draft.action === "map") {
        rulePayload.target_size_id = targetSizeId;
      }
      if (draft.action === "distribute") {
        rulePayload.distribute_size_ids = draft.distributeIds;
      }

      const ruleResponse = await apiFetch(SIZE_RULES_URL, {
        method: "POST",
        body: JSON.stringify(rulePayload)
      });

      if (!ruleResponse.ok) {
        let message = "Failed to save size rule.";
        try {
          const body = (await ruleResponse.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // Ignore non-JSON error body.
        }
        throw new Error(message);
      }

      await Promise.all([fetchSizeRules(), fetchActiveYieldSizes()]);

      const updatedResolved = new Set(sizeSetupResolvedLabels).add(label);
      setSizeSetupResolvedLabels(updatedResolved);

      if (uniqueUnknownSizeLabels.every((pendingLabel) => updatedResolved.has(pendingLabel))) {
        await handleExitSizeSetup();
      }
    } catch (error) {
      setSizeSetupErrors((current) => ({
        ...current,
        [label]: error instanceof Error ? error.message : "Failed to save size rule."
      }));
    } finally {
      setSizeSetupSavingLabel(null);
    }
  }

  async function handleCsvSizeToggle(rawLabel: string, checked: boolean) {
    const upper = rawLabel.toUpperCase();
    const next = checked
      ? csvIgnoredLabels.filter((l) => l !== upper)
      : [...csvIgnoredLabels, upper];
    setCsvIgnoredLabels(next);
    try {
      await apiFetch(CSV_SETTINGS_URL, {
        method: "PATCH",
        body: JSON.stringify({ ignoredSizeLabels: next }),
      });

      // Pending imports can re-derive a fully rules-aware sizeBreakdown from
      // stored raw CSV text (see buildPreviewFile), so re-fetch to reflect
      // the new ignoredSizeLabels immediately instead of relying on the
      // client-side raw-label recompute below, which has no knowledge of
      // saved flowmaster_size_rules and would otherwise disagree with it.
      if (viewedPendingWeek) {
        await handlePendingWeekClick(viewedPendingWeek.isoYear, viewedPendingWeek.isoWeek);
      }
    } catch {
      // Best-effort save; local state already updated.
    }
  }

  async function handlePendingWeekClick(isoYear: number | null, isoWeek: number | null) {
    const weekParams =
      isoYear !== null && isoWeek !== null
        ? `&isoYear=${isoYear}&isoWeek=${isoWeek}`
        : "";
    try {
      const res = await apiFetch(`${PENDING_IMPORTS_URL}${FLOWMASTER_FILTER}${weekParams}`);
      if (!res.ok) return;
      const body = (await res.json()) as { files?: PdfPreviewFile[] };
      const files = body.files ?? [];
      setPdfPreviewFiles(files);
      setPdfPreviewError(null);
      setPdfImportStatus(null);
      setPdfImportedCardKeys(new Set());
      setPdfCardImportingKeys(new Set());
      setPdfCardImportErrors({});
      setViewedPendingWeek({ isoYear, isoWeek });
      void fetchCsvSettings();
      setIsPdfPreviewOpen(true);

      if (hasUnresolvedSizes(files)) {
        setIsSizeSetupOpen(true);
      }
    } catch {
      // Silently ignore — user can retry by clicking the card again.
    }
  }

  useEffect(() => {
    void fetchOptionsAndEntries();
    void fetchInitialRecentEntries();
    void fetchPendingWeeks();
    void fetchSizeRules();
  }, []);

  useEffect(() => {
    const year = Number(form.year);
    const week = Number(form.week);
    if (!Number.isInteger(year) || !Number.isInteger(week)) return;
    void fetchWeekEntries(year, week);
  }, [form.year, form.week]);

  async function executeSubmit(submitPayload: {
    variety_id: string;
    year: number;
    week: number;
    packed_date: string | null;
    size_kg: Record<string, number>;
    average_fruit_weight_g: number | null;
  }) {
    setSaving(true);

    try {
      const method = editingId ? "PUT" : "POST";
      const url = editingId ? `${ENTRIES_URL}/${editingId}` : ENTRIES_URL;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(submitPayload)
      });

      if (!response.ok) {
        let message = `${editingId ? "Update" : "Save"} failed`;
        try {
          const responseBody = (await response.json()) as { message?: string };
          if (responseBody.message) {
            message = responseBody.message;
          }
        } catch {
          // Ignore
        }
        throw new Error(message);
      }

      let appendMessage: string | null = null;
      try {
        const responseBody = (await response.json()) as { message?: string };
        if (responseBody.message) {
          appendMessage = responseBody.message;
        }
      } catch {
        // Ignore
      }

      setSuccessMessage(appendMessage);
      setEditingId(null);
      setForm((current) => ({
        ...current,
        average_fruit_weight_g: "",
        size_kg: resetSizeKgFields(yieldSizes)
      }));
      setIsEntryModalOpen(false);

      await Promise.all([
        fetchWeekEntries(submitPayload.year, submitPayload.week),
        refreshRecentEntries()
      ]);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save yield entry"
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!form.variety_id) {
      setError("Variety is required.");
      return;
    }

    const payloadSizeKg: Record<string, number> = {};
    for (const size of yieldSizes) {
      const kg = numberOrZero(form.size_kg[size.id] ?? "0");
      if (kg < 0) {
        setError("Kg values must be 0 or greater.");
        return;
      }
      payloadSizeKg[size.id] = kg;
    }

    const submitPayload = {
      variety_id: form.variety_id,
      year: Number(form.year),
      week: Number(form.week),
      packed_date: form.packed_date || null,
      size_kg: payloadSizeKg,
      average_fruit_weight_g:
        form.average_fruit_weight_g.trim() === ""
          ? null
          : Number(form.average_fruit_weight_g)
    };

    if (!Number.isInteger(submitPayload.year)) {
      setError("Year is required.");
      return;
    }

    if (!Number.isInteger(submitPayload.week)) {
      setError("Week is required.");
      return;
    }

    if (
      submitPayload.average_fruit_weight_g !== null &&
      (!Number.isFinite(submitPayload.average_fruit_weight_g) || submitPayload.average_fruit_weight_g < 0)
    ) {
      setError("Average fruit weight must be 0 or greater.");
      return;
    }

    // For new entries, check if a weekly entry already exists and ask for confirmation.
    // Fetched fresh (rather than relying on the reactive weekEntries state) so a
    // just-changed year/week can't race the in-flight weekEntries fetch and miss
    // an existing entry.
    if (!editingId) {
      const existingEntry = await checkExistingWeekEntry(
        submitPayload.variety_id,
        submitPayload.year,
        submitPayload.week
      );

      if (existingEntry) {
        const varietyName =
          varieties.find((v) => v.id === submitPayload.variety_id)?.name ?? "this variety";
        setPendingAppend({ varietyName, week: submitPayload.week, year: submitPayload.year, payload: submitPayload });
        return;
      }
    }

    await executeSubmit(submitPayload);
  }

  function beginEdit(entry: YieldEntry) {
    const nextSizeKg = resetSizeKgFields(yieldSizes);
    for (const [sizeId, kg] of Object.entries(entry.size_kg ?? {})) {
      nextSizeKg[sizeId] = String(kg);
    }

    setEditingId(entry.id);
    setIsEntryModalOpen(true);
    setForm({
      variety_id: entry.variety_id,
      year: String(entry.year),
      week: String(entry.week),
      packed_date: entry.packed_date ?? localIsoDate(new Date()),
      average_fruit_weight_g:
        entry.average_fruit_weight_g === null ? "" : String(entry.average_fruit_weight_g),
      size_kg: nextSizeKg
    });
    setError(null);
  }

  function openEntryModal() {
    setError(null);
    setEditingId(null);
    setForm({
      variety_id: varieties[0]?.id ?? "",
      year: String(currentYear),
      week: String(getCurrentWeek(currentYear)),
      packed_date: localIsoDate(new Date()),
      average_fruit_weight_g: "",
      size_kg: resetSizeKgFields(yieldSizes)
    });
    setIsEntryModalOpen(true);
  }

  function closeEntryModal() {
    setIsEntryModalOpen(false);
    setEditingId(null);
    setError(null);
    setForm({
      variety_id: varieties[0]?.id ?? "",
      year: String(currentYear),
      week: String(getCurrentWeek(currentYear)),
      packed_date: localIsoDate(new Date()),
      average_fruit_weight_g: "",
      size_kg: resetSizeKgFields(yieldSizes)
    });
  }

  async function deleteEntry(id: string) {
    const confirmed = window.confirm("Delete this yield entry?");
    if (!confirmed) {
      return;
    }

    setError(null);
    setSuccessMessage(null);

    try {
      const response = await apiFetch(`${ENTRIES_URL}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed (${response.status})`);
      }

      if (editingId === id) {
        setEditingId(null);
      }

      await Promise.all([
        fetchWeekEntries(Number(form.year), Number(form.week)),
        refreshRecentEntries()
      ]);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete entry"
      );
    }
  }

  function closePdfPreviewModal() {
    setIsPdfPreviewOpen(false);
    setPdfPreviewFiles([]);
    setPdfPreviewUploading(false);
    setPdfPreviewError(null);
    setPdfImportAllRunning(false);
    setPdfImportStatus(null);
    setPdfImportedCardKeys(new Set());
    setPdfCardImportingKeys(new Set());
    setPdfCardImportErrors({});
    setIsSizeSetupOpen(false);
    setSizeSetupDrafts({});
    setSizeSetupErrors({});
    setSizeSetupResolvedLabels(new Set());
    setCsvTemplateFiles([]);
    setCsvTemplateOverrides({});
    setCsvTemplateRecomputing(new Set());
    setCsvTemplateImportingKey(null);
    setCsvTemplateImportStatus({});

    if (pdfFileInputRef.current) {
      pdfFileInputRef.current.value = "";
    }
  }

  async function handlePdfFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = event.target.files;

    if (!selectedFiles || selectedFiles.length === 0) {
      return;
    }

    setPdfPreviewError(null);
    setPdfImportStatus(null);
    setPdfImportedCardKeys(new Set());
    setPdfCardImportingKeys(new Set());
    setPdfCardImportErrors({});
    setViewedPendingWeek(null);
    setPdfPreviewUploading(true);
    void fetchCsvTemplateOptions();

    const formData = new FormData();
    for (const file of Array.from(selectedFiles)) {
      formData.append("files", file);
    }

    try {
      const response = await apiFetch(PDF_PREVIEW_URL, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        let message = `PDF preview failed (${response.status})`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) {
            message = body.message;
          }
        } catch {
          // Ignore non-JSON error body.
        }
        throw new Error(message);
      }

      const body = (await response.json()) as {
        success: boolean;
        files?: Array<PdfPreviewFile | CsvTemplateManualUploadItem>;
      };

      if (!body.success || !Array.isArray(body.files)) {
        throw new Error("PDF preview response was invalid.");
      }

      const csvItems = body.files.filter((f): f is CsvTemplateManualUploadItem => "source" in f && f.source === "csv_template");
      const pdfItems = body.files.filter((f): f is PdfPreviewFile => !("source" in f) || f.source !== "csv_template");

      setPdfPreviewFiles(pdfItems);
      setCsvTemplateFiles(csvItems);
      setCsvTemplateOverrides({});
      setCsvTemplateImportStatus({});

      if (hasUnresolvedSizes(pdfItems)) {
        setIsSizeSetupOpen(true);
      }

      if (csvItems.some((f) => f.success && f.kind === "close")) {
        setPdfPreviewError((current) => current ?? "One or more CSV files closely resemble a saved template but didn't match exactly — review before importing (see below).");
      }
      if (csvItems.some((f) => f.success && f.kind === "none")) {
        setPdfPreviewError((current) => current ?? "One or more CSV files don't match any saved template yet — they've been sent to the CSV Templates tab to set one up.");
      }
    } catch (uploadError) {
      setPdfPreviewFiles([]);
      setCsvTemplateFiles([]);
      setPdfPreviewError(
        uploadError instanceof Error
          ? uploadError.message
          : "Failed to upload and parse PDF files."
      );
    } finally {
      setPdfPreviewUploading(false);
      event.target.value = "";
    }
  }

  async function fetchCsvTemplateOptions() {
    try {
      const res = await apiFetch(CSV_TEMPLATES_URL);
      if (!res.ok) return;
      setCsvTemplateOptions((await res.json()) as CsvTemplateSummary[]);
    } catch {
      // Non-fatal — the override dropdown just stays limited to the auto-matched template.
    }
  }

  async function handleCsvTemplateOverride(sourceFileId: string, filename: string, newTemplateId: string) {
    setCsvTemplateRecomputing((current) => new Set(current).add(sourceFileId));
    setCsvTemplateOverrides((current) => ({ ...current, [sourceFileId]: newTemplateId }));
    try {
      const res = await apiFetch(CSV_TEMPLATE_PREVIEW_URL, {
        method: "POST",
        body: JSON.stringify({ sourceFileId, templateId: newTemplateId })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to switch template (${res.status})`);
      }
      const result = (await res.json()) as { preview: NormalizedPreview; templateVersion: number | null };
      const selectedTemplate = csvTemplateOptions.find((t) => t.id === newTemplateId);
      setCsvTemplateFiles((current) =>
        current.map((f): CsvTemplateManualUploadItem => {
          if (!f.success || f.sourceFileId !== sourceFileId) return f;
          return {
            filename,
            success: true,
            source: "csv_template",
            kind: "exact",
            sourceFileId,
            templateId: newTemplateId,
            templateName: selectedTemplate?.name ?? "Selected template",
            templateVersion: result.templateVersion ?? selectedTemplate?.version ?? 1,
            preview: result.preview
          };
        })
      );
    } catch (err) {
      setPdfPreviewError(err instanceof Error ? err.message : "Failed to switch template.");
    } finally {
      setCsvTemplateRecomputing((current) => {
        const next = new Set(current);
        next.delete(sourceFileId);
        return next;
      });
    }
  }

  async function handleImportCsvTemplateGroup(sourceFileId: string, templateId: string, group: NormalizedGroup) {
    setCsvTemplateImportingKey(group.groupKey);
    setCsvTemplateImportStatus((current) => ({ ...current, [group.groupKey]: "" }));
    try {
      const res = await apiFetch(CSV_TEMPLATE_IMPORT_URL, {
        method: "POST",
        body: JSON.stringify({ sourceFileId, templateId, groupKey: group.groupKey, approvedGroup: group })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Import failed (${res.status})`);
      }
      const result = (await res.json()) as { mode: "create" | "append" };
      setCsvTemplateImportStatus((current) => ({ ...current, [group.groupKey]: `Imported (${result.mode}).` }));
      await refreshEntriesAfterImport();
    } catch (err) {
      setCsvTemplateImportStatus((current) => ({
        ...current,
        [group.groupKey]: err instanceof Error ? err.message : "Import failed."
      }));
    } finally {
      setCsvTemplateImportingKey(null);
    }
  }

  async function refreshEntriesAfterImport() {
    await Promise.all([
      fetchWeekEntries(Number(form.year), Number(form.week)),
      refreshRecentEntries()
    ]);
  }

  interface ColorGroupData {
    color: VarietyColor;
    totalKg: number;
    varieties: Array<{
      id: string;
      name: string;
      kg: number;
      sharePercent: number;
    }>;
  }

  const visibleRecentEntries = useMemo(
    () =>
      recentEntriesCollapsed
        ? loadedRecentEntries.slice(0, RECENT_ENTRIES_INITIAL_LIMIT)
        : loadedRecentEntries,
    [loadedRecentEntries, recentEntriesCollapsed]
  );

  const canExpandRecentEntries =
    (recentEntriesCollapsed && loadedRecentEntries.length > RECENT_ENTRIES_INITIAL_LIMIT) ||
    recentEntriesHasMore;

  const colorGroups = useMemo(() => {
    const selectedYear = Number(form.year);
    const selectedWeek = Number(form.week);

    const matchingWeekEntries = weekEntries.filter(
      (entry) => entry.year === selectedYear && entry.week === selectedWeek
    );

    if (matchingWeekEntries.length === 0) {
      return [];
    }

    const varietyMap = new Map<string, VarietyOption>();
    for (const variety of varieties) {
      varietyMap.set(variety.id, variety);
    }

    const grouped = new Map<VarietyColor, Map<string, YieldEntry>>();

    for (const entry of matchingWeekEntries) {
      const variety = varietyMap.get(entry.variety_id);
      if (!variety) continue;

      if (!grouped.has(variety.color)) {
        grouped.set(variety.color, new Map());
      }
      grouped.get(variety.color)!.set(entry.variety_id, entry);
    }

    const result: ColorGroupData[] = [];

    for (const [color, varietyEntries] of grouped) {
      let totalKg = 0;
      const colorVarieties: ColorGroupData["varieties"] = [];

      for (const [varietyId, entry] of varietyEntries) {
        totalKg += entry.total_kg;
      }

      for (const [varietyId, entry] of varietyEntries) {
        const variety = varietyMap.get(varietyId)!;
        const sharePercent = totalKg > 0 ? (entry.total_kg / totalKg) * 100 : 0;

        colorVarieties.push({
          id: varietyId,
          name: variety.name,
          kg: entry.total_kg,
          sharePercent: roundTo(sharePercent, 2)
        });
      }

      result.push({
        color,
        totalKg: roundTo(totalKg, 3),
        varieties: colorVarieties
      });
    }

    return result;
  }, [weekEntries, form.year, form.week, varieties]);

  const pdfPreviewFailures = useMemo(
    () => pdfPreviewFiles.filter((file): file is PdfPreviewFileFailure => !file.success),
    [pdfPreviewFiles]
  );

  // Every unique unknown FlowMaster size label across all loaded preview
  // files (not just the first one) — the set the size setup workflow works
  // through. Skipped files (already-imported/duplicate) are excluded since
  // their sizes don't affect anything importable.
  const uniqueUnknownSizeLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const file of pdfPreviewFiles) {
      if (!file.success || file.skipped) continue;
      for (const label of file.unknownSizes) {
        labels.add(label);
      }
    }
    return Array.from(labels).sort((a, b) => a.localeCompare(b));
  }, [pdfPreviewFiles]);

  const groupedPdfPreviewCards = useMemo(() => {
    const ignoredSet = new Set(csvIgnoredLabels.map((l) => l.toUpperCase()));
    const grouped = new Map<string, GroupedPdfPreviewCard>();

    for (const file of pdfPreviewFiles) {
      if (!file.success) continue;

      const computedTotalKg = calculateMappedTotalKg(file.sizeBreakdown, file.unknownSizes);

      const normalizedWarnings = file.warnings.filter(
        (warning) =>
          !warning.startsWith("Total kg mismatch:") &&
          !warning.startsWith("Printed total kg differed from size total.")
      );

      const varietyKey = file.matchedVariety.varietyId ?? file.variety ?? "unknown-variety";
      const weekKey = file.isoWeek === null ? "unknown-week" : String(file.isoWeek);
      const yearKey = file.isoYear === null ? "unknown-year" : String(file.isoYear);
      const key = `${varietyKey}::${weekKey}::${yearKey}`;

      const existing = grouped.get(key);
      const skipReason =
        file.alreadyImported
          ? file.lotNumber
            ? `Lot ${file.lotNumber} was already imported and will be skipped.`
            : "This run was already imported and will be skipped."
          : file.skipped
            ? file.lotNumber
              ? `Duplicate file/run detected for Lot ${file.lotNumber}. It was only counted once.`
              : "Duplicate file/run detected in this upload. It was only counted once."
            : null;

      const sourceReading = {
        id: file.id ?? null,
        filename: file.filename,
        lotNumber: file.lotNumber,
        startDate: file.startDate,
        startTime: file.startTime,
        printedTotalKg: file.totalKg,
        computedTotalKg,
        skipped: file.skipped,
        skipReason,
        originalVarietyName: file.variety,
        isOverridden: file.isOverridden ?? false
      };

      const fileCsvSizes = file.csvSizes ?? [];

      if (!existing) {
        grouped.set(key, {
          key,
          matchedVarietyId: file.matchedVariety.varietyId,
          varietyName: file.matchedVariety.varietyName ?? file.variety ?? "Unknown variety",
          isoWeek: file.isoWeek,
          isoYear: file.isoYear,
          sourceFiles: [file.filename],
          sourceReadings: [sourceReading],
          totalKg: file.skipped ? 0 : computedTotalKg,
          averageFruitWeightG: null,
          printedTotalKg: file.skipped ? null : file.totalKg,
          sizeBreakdown: file.skipped ? {} : { ...file.sizeBreakdown },
          warnings: [...normalizedWarnings],
          unknownSizes: file.skipped ? [] : [...file.unknownSizes],
          hasMatchedVariety: file.matchedVariety.found,
          duplicateFound: file.duplicateStatus.found,
          mappedCount: file.skipped ? 0 : file.sizeMappingStatus.mappedCount,
          unmappedCount: file.skipped ? 0 : file.sizeMappingStatus.unmappedCount,
          hasImportableReadings: !file.skipped,
          csvSizes: file.skipped ? [] : [...fileCsvSizes],
          isCsvSource: fileCsvSizes.length > 0,
        });
      } else {
        existing.sourceFiles.push(file.filename);
        existing.sourceReadings.push(sourceReading);
        existing.totalKg += file.skipped ? 0 : computedTotalKg;
        existing.matchedVarietyId = existing.matchedVarietyId ?? file.matchedVariety.varietyId;
        existing.printedTotalKg =
          file.skipped
            ? existing.printedTotalKg
            : (existing.printedTotalKg === null
              ? file.totalKg
              : existing.printedTotalKg + (file.totalKg ?? 0));
        existing.hasMatchedVariety = existing.hasMatchedVariety || file.matchedVariety.found;
        existing.duplicateFound = existing.duplicateFound || file.duplicateStatus.found;
        existing.mappedCount += file.skipped ? 0 : file.sizeMappingStatus.mappedCount;
        existing.unmappedCount += file.skipped ? 0 : file.sizeMappingStatus.unmappedCount;
        existing.hasImportableReadings = existing.hasImportableReadings || !file.skipped;

        if (!file.skipped) {
          for (const [size, kg] of Object.entries(file.sizeBreakdown)) {
            existing.sizeBreakdown[size] = (existing.sizeBreakdown[size] ?? 0) + kg;
          }
          existing.unknownSizes.push(...file.unknownSizes);
          // Merge csvSizes by rawLabel, summing kg.
          if (fileCsvSizes.length > 0) {
            const csvMap = new Map(existing.csvSizes.map((s) => [s.rawLabel, { ...s }]));
            for (const entry of fileCsvSizes) {
              const ex = csvMap.get(entry.rawLabel);
              if (ex) { ex.kg += entry.kg; } else { csvMap.set(entry.rawLabel, { ...entry }); }
            }
            existing.csvSizes = Array.from(csvMap.values());
            existing.isCsvSource = true;
          }
        }

        existing.warnings.push(...normalizedWarnings);
      }
    }

    const weightedNumeratorByKey = new Map<string, number>();
    const weightedDenominatorByKey = new Map<string, number>();

    for (const file of pdfPreviewFiles) {
      if (!file.success) continue;
      if (file.skipped) continue;

      const varietyKey = file.matchedVariety.varietyId ?? file.variety ?? "unknown-variety";
      const weekKey = file.isoWeek === null ? "unknown-week" : String(file.isoWeek);
      const yearKey = file.isoYear === null ? "unknown-year" : String(file.isoYear);
      const key = `${varietyKey}::${weekKey}::${yearKey}`;

      const computedTotalKg = calculateMappedTotalKg(file.sizeBreakdown, file.unknownSizes);

      if (
        file.averageFruitWeightG !== null &&
        Number.isFinite(file.averageFruitWeightG) &&
        Number.isFinite(computedTotalKg) &&
        computedTotalKg > 0
      ) {
        weightedNumeratorByKey.set(
          key,
          (weightedNumeratorByKey.get(key) ?? 0) + file.averageFruitWeightG * computedTotalKg
        );
        weightedDenominatorByKey.set(
          key,
          (weightedDenominatorByKey.get(key) ?? 0) + computedTotalKg
        );
      }
    }

    const cards = Array.from(grouped.values()).map((group) => {
      const numerator = weightedNumeratorByKey.get(group.key) ?? 0;
      const denominator = weightedDenominatorByKey.get(group.key) ?? 0;

      let finalGroup = {
        ...group,
        averageFruitWeightG: denominator > 0 ? numerator / denominator : null,
        warnings: Array.from(new Set(group.warnings)),
        unknownSizes: Array.from(new Set(group.unknownSizes)),
      };

      // For freshly-uploaded CSV previews (not yet queued — no reading has an
      // id), recompute sizeBreakdown/unknownSizes/totalKg/counts from csvSizes
      // + current ignoredSet so ignore-toggles take effect immediately without
      // a server round trip. Pending-import cards (readings DO have an id) skip
      // this entirely and instead get a full server re-fetch from
      // handleCsvSizeToggle, because this recompute only understands the CSV
      // parser's built-in size-label map — not saved flowmaster_size_rules —
      // and would silently disagree with (and overwrite) the correct,
      // rule-aware totals already merged into finalGroup above.
      const isPendingImportGroup = group.sourceReadings.some((reading) => reading.id !== null);
      const hasRelevantIgnoreToggle = group.csvSizes.some((entry) =>
        ignoredSet.has(entry.rawLabel.toUpperCase())
      );

      if (!isPendingImportGroup && group.isCsvSource && group.csvSizes.length > 0 && hasRelevantIgnoreToggle) {
        const csvBreakdown: Record<string, number> = {};
        const csvUnknown: string[] = [];
        let csvMapped = 0;
        let csvUnmapped = 0;

        for (const entry of group.csvSizes) {
          if (ignoredSet.has(entry.rawLabel.toUpperCase())) continue;
          if (entry.mappedSizeName !== null) {
            csvBreakdown[entry.mappedSizeName] = (csvBreakdown[entry.mappedSizeName] ?? 0) + entry.kg;
            csvMapped += 1;
          } else {
            csvUnknown.push(entry.rawLabel);
            csvUnmapped += 1;
          }
        }

        const csvTotalKg = Object.values(csvBreakdown).reduce((s, k) => s + k, 0);

        // Filter out "New size found: X." warnings for now-ignored labels.
        const filteredWarnings = finalGroup.warnings.filter((w) => {
          const m = w.match(/^New size found: (.+)\. Add this size/);
          if (!m) return true;
          return !ignoredSet.has(m[1].toUpperCase());
        });

        finalGroup = {
          ...finalGroup,
          sizeBreakdown: csvBreakdown,
          unknownSizes: csvUnknown,
          totalKg: csvTotalKg,
          mappedCount: csvMapped,
          unmappedCount: csvUnmapped,
          warnings: filteredWarnings,
        };
      }

      return finalGroup;
    });

    cards.sort((a, b) => {
      if (a.isoYear !== b.isoYear) {
        return (b.isoYear ?? -1) - (a.isoYear ?? -1);
      }
      if (a.isoWeek !== b.isoWeek) {
        return (b.isoWeek ?? -1) - (a.isoWeek ?? -1);
      }
      return a.varietyName.localeCompare(b.varietyName);
    });

    return cards;
  }, [pdfPreviewFiles, csvIgnoredLabels]);

  const pdfCardValidationByKey = useMemo(() => {
    const result: Record<string, string | null> = {};

    for (const group of groupedPdfPreviewCards) {
      if (!group.matchedVarietyId || !group.hasMatchedVariety) {
        result[group.key] = "Variety must be matched before import.";
        continue;
      }

      if (!group.hasImportableReadings) {
        result[group.key] = "All source readings in this card were skipped.";
        continue;
      }

      if (group.unmappedCount > 0 || group.unknownSizes.length > 0) {
        result[group.key] = "All sizes must be mapped before import.";
        continue;
      }

      if (group.isoYear === null || group.isoWeek === null) {
        result[group.key] = "ISO year and ISO week are required before import.";
        continue;
      }

      if (!Number.isFinite(group.totalKg)) {
        result[group.key] = "Total kg from sizes is missing.";
        continue;
      }

      result[group.key] = null;
    }

    return result;
  }, [groupedPdfPreviewCards]);

  const hasPendingImportCards = useMemo(
    () =>
      groupedPdfPreviewCards.some(
        (group) => !pdfImportedCardKeys.has(group.key) && !pdfCardValidationByKey[group.key]
      ),
    [groupedPdfPreviewCards, pdfImportedCardKeys, pdfCardValidationByKey]
  );

  // Aggregate all unique raw CSV size labels across every preview file (non-skipped).
  // Used for the single global CSV Size Preferences panel in the modal.
  const allDetectedCsvSizes = useMemo(() => {
    const map = new Map<string, { mappedSizeName: string | null; kg: number }>();
    for (const file of pdfPreviewFiles) {
      if (!file.success || file.skipped) continue;
      for (const entry of (file.csvSizes ?? [])) {
        const ex = map.get(entry.rawLabel);
        if (ex) { ex.kg += entry.kg; } else { map.set(entry.rawLabel, { mappedSizeName: entry.mappedSizeName, kg: entry.kg }); }
      }
    }
    return Array.from(map.entries())
      .map(([rawLabel, d]) => ({ rawLabel, mappedSizeName: d.mappedSizeName, kg: d.kg }))
      .sort((a, b) => {
        const ia = KNOWN_SIZE_ORDER.indexOf(a.mappedSizeName ?? "");
        const ib = KNOWN_SIZE_ORDER.indexOf(b.mappedSizeName ?? "");
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return a.rawLabel.localeCompare(b.rawLabel);
      });
  }, [pdfPreviewFiles]);

  async function importGroupedCard(
    group: GroupedPdfPreviewCard,
    mode: "create" | "append"
  ): Promise<boolean> {
    const validationError = pdfCardValidationByKey[group.key];
    if (validationError) {
      setPdfCardImportErrors((current) => ({
        ...current,
        [group.key]: validationError
      }));
      return false;
    }

    if (!group.matchedVarietyId || group.isoYear === null || group.isoWeek === null) {
      setPdfCardImportErrors((current) => ({
        ...current,
        [group.key]: "Card data is incomplete for import."
      }));
      return false;
    }

    setPdfCardImportErrors((current) => {
      const next = { ...current };
      delete next[group.key];
      return next;
    });
    setPdfCardImportingKeys((current) => new Set(current).add(group.key));

    try {
      const importableSourceRuns = group.sourceReadings
        .filter((reading) => !reading.skipped && reading.lotNumber != null)
        .map((reading) => ({
          lotNumber: reading.lotNumber ?? "",
          startTime: reading.startTime,
          sourceFilename: reading.filename
        }));

      if (importableSourceRuns.length === 0) {
        throw new Error("No new lot readings are available to import for this preview card.");
      }

      const packedDate =
        group.sourceReadings
          .filter((r) => !r.skipped && r.startDate != null)
          .map((r) => r.startDate)[0] ?? null;

      const response = await apiFetch(PDF_IMPORT_URL, {
        method: "POST",
        body: JSON.stringify({
          mode,
          varietyId: group.matchedVarietyId,
          isoYear: group.isoYear,
          isoWeek: group.isoWeek,
          sizeBreakdown: group.sizeBreakdown,
          averageFruitWeightG: group.averageFruitWeightG,
          packedDate,
          sourceRuns: importableSourceRuns
        })
      });

      if (!response.ok) {
        let message = `Import failed (${response.status})`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) {
            message = body.message;
          }
        } catch {
          // Ignore non-JSON body.
        }

        throw new Error(message);
      }

      setPdfImportedCardKeys((current) => new Set(current).add(group.key));
      await refreshEntriesAfterImport();
      void fetchPendingWeeks();
      return true;
    } catch (error) {
      setPdfCardImportErrors((current) => ({
        ...current,
        [group.key]: error instanceof Error ? error.message : "Import failed."
      }));
      return false;
    } finally {
      setPdfCardImportingKeys((current) => {
        const next = new Set(current);
        next.delete(group.key);
        return next;
      });
    }
  }

  async function handleImportCard(group: GroupedPdfPreviewCard) {
    setPdfImportStatus(null);

    await importGroupedCard(group, group.duplicateFound ? "append" : "create");
  }

  async function handleReassignSave(readingId: string, varietyId: string) {
    setReassignErrors((current) => {
      const next = { ...current };
      delete next[readingId];
      return next;
    });
    setReassignSavingId(readingId);

    try {
      const response = await apiFetch(`${PENDING_IMPORTS_URL}/${readingId}`, {
        method: "PATCH",
        body: JSON.stringify({ varietyId: varietyId || null })
      });

      if (!response.ok) {
        let message = `Reassign failed (${response.status})`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) {
            message = body.message;
          }
        } catch {
          // Ignore non-JSON body.
        }
        throw new Error(message);
      }

      const body = (await response.json()) as { success: true; file: PdfPreviewFileSuccess };

      setPdfPreviewFiles((current) =>
        current.map((file) => (file.success && file.id === readingId ? body.file : file))
      );
      setReassigningReadingId(null);
      setReassignTargetVarietyId("");
    } catch (error) {
      setReassignErrors((current) => ({
        ...current,
        [readingId]: error instanceof Error ? error.message : "Reassign failed."
      }));
    } finally {
      setReassignSavingId(null);
    }
  }

  // The actual delete, callable from inside the GrowLink confirm modal
  // (see removeReadingConfirm below) once the user confirms — no
  // browser-native confirm() gate here.
  async function removePendingReading(readingId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    setRemoveErrors((current) => {
      const next = { ...current };
      delete next[readingId];
      return next;
    });
    setRemovingReadingId(readingId);

    try {
      const response = await apiFetch(`${PENDING_IMPORTS_URL}/${readingId}`, { method: "DELETE" });

      if (!response.ok) {
        let message = `Remove failed (${response.status})`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) {
            message = body.message;
          }
        } catch {
          // Ignore non-JSON body.
        }
        throw new Error(message);
      }

      setPdfPreviewFiles((current) => current.filter((file) => !(file.success && file.id === readingId)));
      void fetchPendingWeeks();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Remove failed.";
      setRemoveErrors((current) => ({ ...current, [readingId]: message }));
      return { ok: false, message };
    } finally {
      setRemovingReadingId(null);
    }
  }

  async function handleImportAllCards() {
    setPdfImportStatus(null);
    setPdfImportAllRunning(true);

    let importedCount = 0;
    let failedCount = 0;
    let skippedInvalidCount = 0;
    let appendedCount = 0;

    for (const group of groupedPdfPreviewCards) {
      if (pdfImportedCardKeys.has(group.key)) {
        continue;
      }

      const validationError = pdfCardValidationByKey[group.key];
      if (validationError) {
        skippedInvalidCount += 1;
        setPdfCardImportErrors((current) => ({
          ...current,
          [group.key]: validationError
        }));
        continue;
      }

      const mode: "create" | "append" = group.duplicateFound ? "append" : "create";
      const ok = await importGroupedCard(group, mode);
      if (ok) {
        if (mode === "append") {
          appendedCount += 1;
        } else {
          importedCount += 1;
        }
      } else {
        failedCount += 1;
      }
    }

    const statusParts: string[] = [];
    if (importedCount > 0) {
      statusParts.push(`Imported ${importedCount} card${importedCount === 1 ? "" : "s"}.`);
    }

    if (appendedCount > 0) {
      statusParts.push(`Added ${appendedCount} card${appendedCount === 1 ? "" : "s"} to existing weeks.`);
    }

    if (skippedInvalidCount > 0) {
      statusParts.push(`Skipped ${skippedInvalidCount} invalid card${skippedInvalidCount === 1 ? "" : "s"}.`);
    }

    if (failedCount > 0) {
      statusParts.push(`${failedCount} card import${failedCount === 1 ? "" : "s"} failed.`);
    }

    setPdfImportStatus(statusParts.length > 0 ? statusParts.join(" ") : "No importable cards found.");
    setPdfImportAllRunning(false);
  }

  return (
    <div>
      {colorGroups.length > 0 && (
        <div className="coming-soon-card color-share-card">
          <h2>Weekly Color Share</h2>
          <p className="color-share-description">
            Each variety's share of weekly kg within its color
          </p>

          <div className="color-groups-container">
            {colorGroups.map((group) => (
              <div key={group.color} className="color-group">
                <div className="color-group-header">
                  <span className="color-group-name">
                    {group.color.charAt(0).toUpperCase() + group.color.slice(1)}
                  </span>
                  <span className="color-group-total">
                    {group.totalKg.toLocaleString("en-US", {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1
                    })}{" "}
                    kg
                  </span>
                </div>
                <div className="color-group-varieties">
                  {group.varieties.map((variety) => (
                    <div key={variety.id} className="variety-share-row">
                      <span className="variety-name">{variety.name}</span>
                      <span className="variety-kg">
                        {variety.kg.toLocaleString("en-US", {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1
                        })}{" "}
                        kg
                      </span>
                      <span className="variety-percent">
                        {variety.sharePercent.toLocaleString("en-US", {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1
                        })}
                        %
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="yield-entry-layout">
        <div className="cases-entry-header">
          <h2>Kg Entries</h2>
          <div className="kg-entry-header-buttons">
            <button
              type="button"
              className="cases-entry-open-button"
              onClick={openEntryModal}
              disabled={loading}
            >
              Enter Kg Manually
            </button>
            <button
              type="button"
              className="cases-entry-open-button"
              onClick={() => { setIsPdfPreviewOpen(true); void fetchCsvSettings(); }}
              disabled={loading}
            >
              PDF / CSV Upload
            </button>
          </div>
        </div>

        {pendingWeeks.length > 0 && (
          <div className="pending-agent-weeks">
            {pendingWeeks.map((week) => (
              <button
                key={`pending-${week.isoYear ?? "null"}-${week.isoWeek ?? "null"}`}
                type="button"
                className="pending-agent-week-card"
                onClick={() => void handlePendingWeekClick(week.isoYear, week.isoWeek)}
              >
                {week.isoYear !== null && week.isoWeek !== null
                  ? `Week ${week.isoWeek} — ${week.count} imported file${week.count === 1 ? "" : "s"} pending review`
                  : `Unknown week — ${week.count} imported file${week.count === 1 ? "" : "s"} pending review`}
              </button>
            ))}
          </div>
        )}

        <div className="coming-soon-card yield-entry-recent-entries">
          <h2>Recent Entries</h2>

          {error && <p className="form-error">{error}</p>}
          {successMessage && <p className="form-success">{successMessage}</p>}
          {recentEntriesError && <p className="form-error">{recentEntriesError}</p>}

          {loadedRecentEntries.length === 0 && !recentEntriesError && <p>No yield entries yet.</p>}

          {loadedRecentEntries.length > 0 && (
            <>
            <div className="varieties-table-wrapper yield-entry-table-wrapper">
              <table className="varieties-table yield-entry-table">
                <thead>
                  <tr>
                    <th>Variety</th>
                    <th>Year</th>
                    <th>Week</th>
                    <th>Packed Date</th>
                    <th>Total kg</th>
                    <th>kg/m²</th>
                    <th>Total cases</th>
                    <th>Average fruit weight</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecentEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.variety_name}</td>
                      <td>{entry.year}</td>
                      <td>{entry.week}</td>
                      <td>{entry.packed_date ?? "Not recorded"}</td>
                      <td>{roundTo(entry.total_kg, 3)}</td>
                      <td>{roundTo(entry.kg_per_m2, 3)}</td>
                      <td>{roundTo(entry.total_cases, 3)}</td>
                      <td>
                        {entry.average_fruit_weight_g === null
                          ? "-"
                          : roundTo(entry.average_fruit_weight_g, 2)}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button type="button" onClick={() => beginEdit(entry)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => deleteEntry(entry.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="recent-entries-pagination">
              {canExpandRecentEntries ? (
                <button
                  type="button"
                  className="cases-entry-open-button"
                  onClick={handleShowMoreEntries}
                  disabled={recentEntriesLoadingMore}
                >
                  {recentEntriesLoadingMore ? "Loading..." : "Show more entries"}
                </button>
              ) : (
                loadedRecentEntries.length > RECENT_ENTRIES_INITIAL_LIMIT && (
                  <p className="recent-entries-footer">All entries loaded.</p>
                )
              )}
              {!recentEntriesCollapsed && loadedRecentEntries.length > RECENT_ENTRIES_INITIAL_LIMIT && (
                <button type="button" className="cases-entry-open-button" onClick={handleShowLessEntries}>
                  Show less
                </button>
              )}
            </div>
            </>
          )}
        </div>
      </div>

      {isPdfPreviewOpen && !isSizeSetupOpen ? (
        <ModalOverlay
          onClose={closePdfPreviewModal}
          contentClassName="variety-modal pdf-preview-modal"
          titleId="pdf-import-preview-title"
        >
            <div className="pdf-preview-modal-header">
              <h2 id="pdf-import-preview-title">Import Preview</h2>
              <div className="pdf-preview-header-actions">
                {uniqueUnknownSizeLabels.length > 0 && (
                  <button
                    type="button"
                    className="cases-entry-open-button"
                    onClick={() => setIsSizeSetupOpen(true)}
                  >
                    Configure Sizes ({uniqueUnknownSizeLabels.length})
                  </button>
                )}
                <button
                  type="button"
                  className="cases-entry-open-button"
                  onClick={handleImportAllCards}
                  disabled={pdfImportAllRunning || !hasPendingImportCards}
                >
                  {pdfImportAllRunning ? "Importing..." : "Import All"}
                </button>
                <button
                  type="button"
                  className="cases-entry-open-button"
                  onClick={closePdfPreviewModal}
                >
                  Close
                </button>
              </div>
            </div>

            <p className="pdf-preview-subtitle">
              Review parsed data before importing.
            </p>

            <form className="pdf-preview-form" onSubmit={(e) => e.preventDefault()}>
              <input
                ref={pdfFileInputRef}
                type="file"
                accept="application/pdf,.pdf,text/csv,.csv"
                multiple
                onChange={handlePdfFileInputChange}
                disabled={pdfPreviewUploading}
              />
            </form>

            {pdfPreviewError && <p className="form-error">{pdfPreviewError}</p>}
            {pdfImportStatus && <p className="pdf-preview-subtitle">{pdfImportStatus}</p>}
            {pdfPreviewUploading && <p>Parsing PDFs...</p>}

            {csvTemplateFiles.length > 0 && (
              <div className="csv-template-manual-upload-section">
                {csvTemplateFiles.map((item) => {
                  if (!item.success) {
                    return (
                      <div key={item.filename} className="csv-template-pending-card">
                        <strong>{item.filename}</strong>
                        <p className="form-error">{item.error.message}</p>
                      </div>
                    );
                  }
                  if (item.kind === "none") {
                    return (
                      <div key={item.filename} className="csv-template-pending-card">
                        <strong>{item.filename}</strong>
                        <p>No saved template matches this layout yet. Sent to CSV Templates &rarr; Pending CSV Imports to set one up.</p>
                      </div>
                    );
                  }
                  if (item.kind === "close") {
                    return (
                      <div key={item.filename} className="csv-template-pending-card">
                        <strong>{item.filename}</strong>
                        <p className="form-error">
                          Closely resembles &ldquo;{item.closestTemplateName}&rdquo; but doesn&rsquo;t match exactly. Sent to CSV Templates &rarr; Pending
                          CSV Imports to review before importing.
                        </p>
                      </div>
                    );
                  }
                  if (item.kind === "ambiguous") {
                    return (
                      <div key={item.filename} className="csv-template-pending-card">
                        <strong>{item.filename}</strong>
                        <p className="form-error">Multiple saved templates match this exact layout — pick one:</p>
                        <select onChange={(e) => e.target.value && void handleCsvTemplateOverride(item.sourceFileId, item.filename, e.target.value)} defaultValue="">
                          <option value="" disabled>Select a template&hellip;</option>
                          {item.candidates.map((c) => (
                            <option key={c.id} value={c.id}>{c.name} (v{c.version})</option>
                          ))}
                        </select>
                      </div>
                    );
                  }

                  // kind === "exact"
                  const isRecomputing = csvTemplateRecomputing.has(item.sourceFileId);
                  return (
                    <div key={item.filename} className="csv-template-pending-card">
                      <div className="csv-template-pending-card-header">
                        <strong>{item.filename}</strong>
                        <span className="form-success">Template: {item.templateName} (v{item.templateVersion}) &middot; Exact layout match</span>
                      </div>
                      {csvTemplateOptions.length > 1 && (
                        <label>
                          Template:{" "}
                          <select
                            value={csvTemplateOverrides[item.sourceFileId] ?? item.templateId}
                            onChange={(e) => void handleCsvTemplateOverride(item.sourceFileId, item.filename, e.target.value)}
                            disabled={isRecomputing}
                          >
                            {csvTemplateOptions.map((t) => (
                              <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>
                            ))}
                          </select>
                        </label>
                      )}
                      {isRecomputing && <p>Recalculating preview&hellip;</p>}
                      {!isRecomputing && item.preview.validationIssues.length > 0 && (
                        <ul className="form-error csv-template-issue-list">
                          {item.preview.validationIssues.map((issue, i) => (
                            <li key={i}>{issue.message}</li>
                          ))}
                        </ul>
                      )}
                      {!isRecomputing && item.preview.groups.map((group) => {
                        const groupIssues = item.preview.validationIssues.filter((i) => !i.groupKey || i.groupKey === group.groupKey);
                        const canImportGroup = item.preview.canImport && groupIssues.length === 0;
                        return (
                          <div key={group.groupKey} className="csv-template-preview-group">
                            <h4>
                              {group.varietyRaw ?? "Unknown variety"} &middot; {group.packedDate ?? "Not recorded"} &middot; Year {group.isoYear ?? "?"} Week{" "}
                              {group.isoWeek ?? "?"} {group.lotNumber ? `· Lot ${group.lotNumber}` : ""}
                            </h4>
                            <table className="varieties-table">
                              <thead><tr><th>Size</th><th>kg</th></tr></thead>
                              <tbody>
                                {Object.entries(group.sizeKg).map(([name, kg]) => (
                                  <tr key={name}><td>{name}</td><td>{kg.toFixed(2)}</td></tr>
                                ))}
                              </tbody>
                            </table>
                            <table className="varieties-table csv-template-reconciliation">
                              <tbody>
                                <tr><td>Final mapped kg</td><td>{group.reconciliation.recognizedSizeKg.toFixed(2)} kg</td></tr>
                                <tr><td>Included piece count</td><td>{group.pieceCount}</td></tr>
                                <tr><td>AFW</td><td>{group.averageFruitWeightG !== null ? `${group.averageFruitWeightG.toFixed(1)} g` : "-"}</td></tr>
                                <tr><td>Ignored kg</td><td>{group.reconciliation.ignoredKg.toFixed(2)} kg</td></tr>
                                <tr><td>Distributed kg</td><td>{group.reconciliation.distributedKg.toFixed(2)} kg</td></tr>
                                <tr><td>Unresolved kg</td><td>{group.reconciliation.unresolvedKg.toFixed(2)} kg</td></tr>
                                {group.reconciliation.difference !== null && (
                                  <tr>
                                    <td>Reconciliation difference</td>
                                    <td className={group.reconciliation.unexplainedDifference ? "form-error" : undefined}>
                                      {group.reconciliation.difference.toFixed(2)} kg
                                    </td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                            {groupIssues.length > 0 && (
                              <ul className="form-error">
                                {groupIssues.map((issue, i) => <li key={i}>{issue.message}</li>)}
                              </ul>
                            )}
                            <button
                              type="button"
                              className="cases-entry-open-button"
                              disabled={!canImportGroup || csvTemplateImportingKey === group.groupKey}
                              onClick={() => void handleImportCsvTemplateGroup(item.sourceFileId, item.templateId, group)}
                            >
                              {csvTemplateImportingKey === group.groupKey ? "Importing..." : "Import"}
                            </button>
                            {csvTemplateImportStatus[group.groupKey] && <span> {csvTemplateImportStatus[group.groupKey]}</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {!pdfPreviewUploading && groupedPdfPreviewCards.length === 0 && pdfPreviewFailures.length === 0 && csvTemplateFiles.length === 0 && (
              <p className="pdf-preview-subtitle">Upload one or more PDFs or CSVs to see a preview.</p>
            )}

            {allDetectedCsvSizes.length > 0 && (
              <div className="csv-size-preferences-panel">
                <h3 className="csv-size-preferences-title">CSV Size Preferences</h3>
                <p className="csv-size-preferences-hint">
                  Raw kg detected per label, before saved size rules are applied — totals here will not match
                  the final Size Breakdown below. Uncheck any size to exclude it from all imports. Your choices
                  are saved automatically.
                </p>
                <ul className="csv-size-checkbox-list">
                  {allDetectedCsvSizes.map((entry) => {
                    const isIgnored = csvIgnoredLabels
                      .map((l) => l.toUpperCase())
                      .includes(entry.rawLabel.toUpperCase());
                    const displayName =
                      entry.mappedSizeName && entry.mappedSizeName !== entry.rawLabel
                        ? `${entry.rawLabel} → ${entry.mappedSizeName}`
                        : (entry.mappedSizeName ?? entry.rawLabel);
                    return (
                      <li key={`global-csv-${entry.rawLabel}`} className="csv-size-checkbox-row">
                        <label className={`csv-size-label${isIgnored ? " csv-size-ignored" : ""}`}>
                          <input
                            type="checkbox"
                            checked={!isIgnored}
                            onChange={(e) => void handleCsvSizeToggle(entry.rawLabel, e.target.checked)}
                          />
                          <span className="csv-size-name">{displayName}</span>
                          <span className="csv-size-kg">
                            {roundTo(entry.kg, 2)} kg
                            {entry.mappedSizeName === null && (
                              <span className="csv-size-unknown-tag"> unknown</span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {groupedPdfPreviewCards.length > 0 && (
              <div className="pdf-preview-grid">
                {groupedPdfPreviewCards.map((group) => (
                  <article key={group.key} className="pdf-preview-card">
                    <div className="pdf-preview-card-top">
                      <h3>
                        {group.varietyName} · Week {group.isoWeek ?? "-"} · {group.isoYear ?? "-"}
                      </h3>

                      <div className="pdf-preview-status-row">
                        <span
                          className={`pdf-preview-status-pill ${
                            group.hasMatchedVariety ? "ok" : "warn"
                          }`}
                        >
                          {group.hasMatchedVariety ? "Variety Matched" : "Variety Not Found"}
                        </span>
                        <span
                          className={`pdf-preview-status-pill ${
                            group.unmappedCount === 0 ? "ok" : "warn"
                          }`}
                        >
                          {group.unmappedCount === 0 ? "Sizes Mapped" : "Size Setup Needed"}
                        </span>
                        <span
                          className={`pdf-preview-status-pill ${
                            group.duplicateFound ? "warn" : "ok"
                          }`}
                        >
                          {group.duplicateFound ? "Existing Week Has Data" : "No Weekly Entry"}
                        </span>
                      </div>
                    </div>

                    <dl className="pdf-preview-metric-grid">
                      <div className="pdf-preview-metric-cell">
                        <dt>File Count (Importable)</dt>
                        <dd>{group.sourceReadings.filter((reading) => !reading.skipped).length}</dd>
                      </div>
                      <div className="pdf-preview-metric-cell">
                        <dt>Total kg from sizes</dt>
                        <dd>
                          {group.sourceReadings.some((r) => !r.skipped && r.printedTotalKg === null) ? "~" : ""}
                          {roundTo(group.totalKg, 2)}
                        </dd>
                      </div>
                      <div className="pdf-preview-metric-cell">
                        <dt>Average Fruit Weight (g)</dt>
                        <dd>
                          {group.averageFruitWeightG === null
                            ? "-"
                            : roundTo(group.averageFruitWeightG, 2)}
                        </dd>
                      </div>
                      <div className="pdf-preview-metric-cell">
                        <dt>Mapped Size Rows</dt>
                        <dd>{group.mappedCount}</dd>
                      </div>
                    </dl>

                    <div className="pdf-preview-size-section">
                      <h4>Source Readings</h4>
                      <ul className="pdf-source-readings-list">
                        {group.sourceReadings.map((reading) => {
                          const readingKey = reading.id ?? `${group.key}-${reading.filename}`;
                          const isReassigning = reassigningReadingId === readingKey;

                          return (
                            <li
                              key={readingKey}
                              className={reading.skipped ? "pdf-source-reading-skipped" : undefined}
                            >
                              <div className="pdf-source-reading-row">
                                <span>
                                  {reading.filename}
                                  {reading.lotNumber ? ` · Lot ${reading.lotNumber}` : " · Lot missing"}
                                  {reading.startTime
                                    ? ` · ${reading.startTime}`
                                    : reading.startDate
                                      ? ` · ${reading.startDate}`
                                      : ""}
                                  {` · ${Math.round(reading.computedTotalKg).toLocaleString("en-US")} kg`}
                                  {reading.skipped
                                    ? ` · Skipped${reading.skipReason ? ` (${reading.skipReason})` : ""}`
                                    : ""}
                                </span>

                                {reading.id && !isReassigning && (
                                  <div className="pdf-source-reading-actions">
                                    <button
                                      type="button"
                                      className="pdf-source-reading-reassign-button"
                                      onClick={() => {
                                        setReassigningReadingId(readingKey);
                                        setReassignTargetVarietyId(group.matchedVarietyId ?? "");
                                      }}
                                    >
                                      Reassign
                                    </button>
                                    <button
                                      type="button"
                                      className="pdf-source-reading-remove-button"
                                      disabled={removingReadingId === reading.id}
                                      onClick={() => setRemoveReadingConfirm({ readingId: reading.id as string, filename: reading.filename })}
                                    >
                                      {removingReadingId === reading.id ? "Removing..." : "Remove"}
                                    </button>
                                  </div>
                                )}
                              </div>

                              {removeErrors[readingKey] && (
                                <p className="pdf-source-reading-override-error">
                                  {removeErrors[readingKey]}
                                </p>
                              )}

                              {reading.isOverridden && !isReassigning && (
                                <p className="pdf-source-reading-override-note">
                                  Original PDF variety: {reading.originalVarietyName ?? "Unknown"} → Assigned to:{" "}
                                  {group.varietyName}
                                </p>
                              )}

                              {isReassigning && reading.id && (
                                <div className="pdf-source-reading-reassign-form">
                                  <select
                                    value={reassignTargetVarietyId}
                                    onChange={(event) => setReassignTargetVarietyId(event.target.value)}
                                  >
                                    <option value="">Select a variety…</option>
                                    {varieties.map((variety) => (
                                      <option key={variety.id} value={variety.id}>
                                        {variety.name}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={
                                      !reassignTargetVarietyId || reassignSavingId === readingKey
                                    }
                                    onClick={() =>
                                      void handleReassignSave(reading.id as string, reassignTargetVarietyId)
                                    }
                                  >
                                    {reassignSavingId === readingKey ? "Saving..." : "Save"}
                                  </button>
                                  {reading.isOverridden && (
                                    <button
                                      type="button"
                                      disabled={reassignSavingId === readingKey}
                                      onClick={() => void handleReassignSave(reading.id as string, "")}
                                    >
                                      Reset to PDF variety
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setReassigningReadingId(null);
                                      setReassignTargetVarietyId("");
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}

                              {reassignErrors[readingKey] && (
                                <p className="pdf-source-reading-override-error">
                                  {reassignErrors[readingKey]}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>

                    <div className="pdf-preview-size-section">
                      <h4>Size Breakdown</h4>
                      {Object.keys(group.sizeBreakdown).length === 0 ? (
                        <p>-</p>
                      ) : (
                        <ul className="pdf-size-pill-grid">
                          {Object.entries(group.sizeBreakdown)
                            .sort(([sizeA], [sizeB]) => sortSizeNames(sizeA, sizeB))
                            .map(([size, kg]) => (
                              <li key={`${group.key}-${size}`} className="pdf-size-pill">
                                {size}: {roundTo(kg, 2)}
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>

                    {group.unknownSizes.length > 0 && (
                      <div className="pdf-preview-size-section">
                        <h4>Unknown Sizes</h4>
                        <ul>
                          {group.unknownSizes.map((size) => (
                            <li key={`${group.key}-${size}`}>{size}</li>
                          ))}
                        </ul>
                        <button
                          type="button"
                          className="size-setup-configure-button"
                          onClick={() => setIsSizeSetupOpen(true)}
                        >
                          Configure Sizes
                        </button>
                      </div>
                    )}

                    {group.warnings.length > 0 && (
                      <div className="pdf-preview-size-section">
                        <h4>Warnings</h4>
                        <ul className="pdf-preview-warning-list">
                          {group.warnings.map((warning, index) => (
                            <li key={`${group.key}-warning-${index}`}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {pdfCardImportErrors[group.key] && (
                      <div className="pdf-preview-size-section">
                        <h4>Import Status</h4>
                        <ul className="pdf-preview-warning-list">
                          <li>{pdfCardImportErrors[group.key]}</li>
                        </ul>
                      </div>
                    )}

                    <div className="pdf-preview-card-footer">
                      <button
                        type="button"
                        className="cases-entry-open-button"
                        onClick={() => void handleImportCard(group)}
                        disabled={
                          pdfImportedCardKeys.has(group.key) ||
                          pdfCardImportingKeys.has(group.key) ||
                          Boolean(pdfCardValidationByKey[group.key])
                        }
                      >
                        {pdfImportedCardKeys.has(group.key)
                          ? "Imported"
                          : pdfCardImportingKeys.has(group.key)
                            ? "Importing..."
                            : !group.hasImportableReadings
                              ? "No New Lots"
                            : group.duplicateFound
                              ? "Add to Existing Week"
                              : "Import"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {pdfPreviewFailures.length > 0 && (
              <div className="pdf-preview-size-section pdf-preview-failure-section">
                <h4>Files That Failed to Parse</h4>
                <ul className="pdf-preview-warning-list">
                  {pdfPreviewFailures.map((file) => (
                    <li key={`failed-${file.filename}`}>
                      {file.filename}: {file.error.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="form-actions">
              <button
                type="button"
                onClick={handleImportAllCards}
                disabled={pdfImportAllRunning || !hasPendingImportCards}
              >
                {pdfImportAllRunning ? "Importing..." : "Import All"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={closePdfPreviewModal}
              >
                Cancel
              </button>
            </div>
        </ModalOverlay>
      ) : null}

      {isPdfPreviewOpen && isSizeSetupOpen ? (
        <ModalOverlay
          onClose={() => void handleExitSizeSetup()}
          contentClassName="variety-modal size-setup-modal"
          titleId="size-setup-title"
        >
            <div className="pdf-preview-modal-header">
              <h2 id="size-setup-title">Configure New Sizes</h2>
              <div className="pdf-preview-header-actions">
                <button
                  type="button"
                  className="cases-entry-open-button"
                  onClick={() => void handleExitSizeSetup()}
                  disabled={sizeSetupExiting}
                >
                  {sizeSetupExiting ? "Saving..." : "Done"}
                </button>
              </div>
            </div>

            <p className="pdf-preview-subtitle">
              FlowMaster reported {uniqueUnknownSizeLabels.length} size label
              {uniqueUnknownSizeLabels.length === 1 ? "" : "s"} that {uniqueUnknownSizeLabels.length === 1 ? "isn't" : "aren't"} configured
              in GrowLink yet. Choose how each one should be handled — your choice is saved for this organization and applied automatically
              on future imports.
            </p>

            <div className="size-setup-list">
              {uniqueUnknownSizeLabels.length === 0 ? (
                <p>All sizes are now configured.</p>
              ) : (
                uniqueUnknownSizeLabels.map((label) => {
                  const draft = sizeSetupDrafts[label] ?? defaultSizeSetupDraft(label);
                  const isResolved = sizeSetupResolvedLabels.has(label);
                  const isSaving = sizeSetupSavingLabel === label;
                  const rowError = sizeSetupErrors[label];
                  const existingRule = sizeRules.find(
                    (rule) => rule.raw_label.trim().toLowerCase() === label.trim().toLowerCase()
                  );

                  function updateDraft(patch: Partial<SizeSetupDraft>) {
                    setSizeSetupDrafts((current) => ({
                      ...current,
                      [label]: { ...(current[label] ?? defaultSizeSetupDraft(label)), ...patch }
                    }));
                  }

                  return (
                    <div key={label} className={`size-setup-row${isResolved ? " size-setup-row-resolved" : ""}`}>
                      <div className="size-setup-row-header">
                        <span className="size-setup-label">{label}</span>
                        {isResolved && <span className="pdf-preview-status-pill ok">Configured</span>}
                      </div>

                      {existingRule && !isResolved && (
                        <p className="size-setup-hint">
                          A saved rule for this label points at a size that no longer exists. Choose again below.
                        </p>
                      )}

                      {!isResolved && (
                        <>
                          <div className="size-setup-action-choices">
                            {(
                              [
                                { value: "create", label: "Create new size" },
                                { value: "map", label: "Map to existing size" },
                                { value: "ignore", label: "Ignore this label" },
                                { value: "distribute", label: "Distribute proportionally" }
                              ] as Array<{ value: SizeRuleAction; label: string }>
                            ).map((option) => (
                              <label key={option.value} className="size-setup-action-choice">
                                <input
                                  type="radio"
                                  name={`size-setup-action-${label}`}
                                  checked={draft.action === option.value}
                                  onChange={() => updateDraft({ action: option.value })}
                                />
                                {option.label}
                              </label>
                            ))}
                          </div>

                          {draft.action === "create" && (
                            <div className="size-setup-fields">
                              <label>
                                Size name
                                <input
                                  type="text"
                                  value={draft.newSizeName}
                                  onChange={(event) => updateDraft({ newSizeName: event.target.value })}
                                />
                              </label>
                              <label>
                                Sort order
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={draft.newSizeSortOrder}
                                  onChange={(event) => updateDraft({ newSizeSortOrder: event.target.value })}
                                />
                              </label>
                            </div>
                          )}

                          {draft.action === "map" && (
                            <div className="size-setup-fields">
                              <label>
                                Existing size
                                <select
                                  value={draft.mapTargetId}
                                  onChange={(event) => updateDraft({ mapTargetId: event.target.value })}
                                >
                                  <option value="">Select a size…</option>
                                  {yieldSizes.map((size) => (
                                    <option key={size.id} value={size.id}>
                                      {size.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <p className="size-setup-hint">
                                Use this when FlowMaster uses a different name for a size GrowLink already tracks.
                              </p>
                            </div>
                          )}

                          {draft.action === "ignore" && (
                            <p className="size-setup-hint">
                              This label's kg is excluded entirely — not added to totals or averages. Use this for grades or
                              subtotals (e.g. "Class 1") that summarize existing sizes rather than representing a new one.
                            </p>
                          )}

                          {draft.action === "distribute" && (
                            <div className="size-setup-fields">
                              <span className="size-setup-fields-label">Destination sizes</span>
                              <div className="size-setup-checkbox-list">
                                {yieldSizes.map((size) => (
                                  <label key={size.id} className="size-setup-checkbox-item">
                                    <input
                                      type="checkbox"
                                      checked={draft.distributeIds.includes(size.id)}
                                      onChange={(event) => {
                                        const nextIds = event.target.checked
                                          ? [...draft.distributeIds, size.id]
                                          : draft.distributeIds.filter((id) => id !== size.id);
                                        updateDraft({ distributeIds: nextIds });
                                      }}
                                    />
                                    {size.name}
                                  </label>
                                ))}
                              </div>
                              <p className="size-setup-hint">
                                This label's kg is split across the selected sizes, in proportion to how much of each was
                                already packed in the same run. The total imported kg never changes.
                              </p>
                            </div>
                          )}

                          {rowError && <p className="form-error">{rowError}</p>}

                          <div className="size-setup-row-actions">
                            <button type="button" onClick={() => void handleSaveSizeSetupRow(label)} disabled={isSaving}>
                              {isSaving ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => void handleExitSizeSetup()}
                disabled={sizeSetupExiting}
              >
                Cancel
              </button>
            </div>
        </ModalOverlay>
      ) : null}

      {pendingAppend ? (
        <ModalOverlay
          onClose={() => setPendingAppend(null)}
          contentClassName="variety-modal"
          titleId="confirm-append-title"
        >
            <h2 id="confirm-append-title">Add to Existing Entry?</h2>
            <p>
              An entry already exists for <strong>{pendingAppend.varietyName}</strong> Week{" "}
              {pendingAppend.week}, {pendingAppend.year}. Add these kg to the existing weekly
              total?
            </p>
            <div className="form-actions">
              <button
                type="button"
                onClick={async () => {
                  const payload = pendingAppend.payload;
                  setPendingAppend(null);
                  await executeSubmit(payload);
                }}
                disabled={saving}
              >
                {saving ? "Saving..." : "Add to Existing"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setPendingAppend(null)}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
        </ModalOverlay>
      ) : null}

      {removeReadingConfirm ? (
        <ModalOverlay
          onClose={() => {
            if (removingReadingId !== removeReadingConfirm.readingId) setRemoveReadingConfirm(null);
          }}
          contentClassName="variety-modal csv-template-modal"
          titleId="remove-reading-confirm-title"
          closeOnEscape={removingReadingId !== removeReadingConfirm.readingId}
          trapFocus
        >
            <h2 id="remove-reading-confirm-title">Remove this file from pending review?</h2>
            <p>
              Remove &ldquo;{removeReadingConfirm.filename}&rdquo; from pending review? This does not delete anything already
              imported — it only discards this queued file. Re-upload it later if needed.
            </p>
            {removeErrors[removeReadingConfirm.readingId] && <p className="form-error">{removeErrors[removeReadingConfirm.readingId]}</p>}
            <div className="csv-template-modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={removingReadingId === removeReadingConfirm.readingId}
                onClick={() => setRemoveReadingConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-action-button"
                disabled={removingReadingId === removeReadingConfirm.readingId}
                onClick={async () => {
                  const result = await removePendingReading(removeReadingConfirm.readingId);
                  if (result.ok) setRemoveReadingConfirm(null);
                }}
              >
                {removingReadingId === removeReadingConfirm.readingId ? "Removing…" : "Remove"}
              </button>
            </div>
        </ModalOverlay>
      ) : null}

      {isEntryModalOpen ? (
        <ModalOverlay onClose={closeEntryModal} contentClassName="variety-modal" titleId="enter-kg-title">
            <h2 id="enter-kg-title">{editingId ? "Edit Yield Entry" : "Enter Kg"}</h2>

            {error ? <p className="form-error">{error}</p> : null}
            {loading ? <p>Loading...</p> : null}

            {!loading ? (
              <form className="yield-entry-form" onSubmit={handleSubmit}>
                <label>
                  Variety
                  <select
                    value={form.variety_id}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, variety_id: event.target.value }))
                    }
                    required
                  >
                    {varieties.length === 0 && <option value="">No active varieties</option>}
                    {varieties.map((variety) => (
                      <option key={variety.id} value={variety.id}>
                        {variety.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Year
                  <select
                    value={form.year}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, year: event.target.value, week: "1" }))
                    }
                  >
                    {[currentYear - 1, currentYear, currentYear + 1].map((year) => (
                      <option key={year} value={String(year)}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Week
                  <select
                    value={form.week}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, week: event.target.value }))
                    }
                  >
                    {weekOptions.map((week) => (
                      <option key={week.value} value={String(week.value)}>
                        {week.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Packed Date
                  <input
                    type="date"
                    value={form.packed_date}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, packed_date: event.target.value }))
                    }
                  />
                </label>

                <div className="yield-size-fields">
                  {yieldSizes.map((size) => (
                    <label key={size.id}>
                      {size.name} (kg)
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.size_kg[size.id] ?? "0"}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            size_kg: {
                              ...current.size_kg,
                              [size.id]: event.target.value
                            }
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>

                <label>
                  Total kg
                  <input type="number" value={roundTo(totalKg, 3)} readOnly />
                </label>

                <label>
                  Average fruit weight (g)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.average_fruit_weight_g}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        average_fruit_weight_g: event.target.value
                      }))
                    }
                  />
                </label>

                <label>
                  kg/m²
                  <input type="number" value={kgPerM2 === null ? "" : roundTo(kgPerM2, 3)} readOnly />
                </label>

                <label>
                  Total cases
                  <input type="number" value={roundTo(totalCases, 3)} readOnly />
                </label>

                <div className="form-actions">
                  <button type="submit" disabled={saving || varieties.length === 0}>
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={closeEntryModal}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
        </ModalOverlay>
      ) : null}
    </div>
  );
}
