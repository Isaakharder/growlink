import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import { parseCsvGridFromBuffer, parseCsvGrid } from "../utils/csvGridParser";
import { computeFingerprint, computeFingerprintHash, matchFingerprint, type FingerprintCandidate } from "../utils/csvTemplateFingerprint";
import { normalizeCsvWithTemplate, type EngineContext } from "../utils/csvTemplateEngine";
import { buildWeeklyCards, type PendingSourceEntry, type WeeklyCard } from "../utils/csvWeeklyCards";
import type {
  BlankRowBehavior,
  ColumnMapping,
  ConditionalRowRule,
  FixedCellMapping,
  NormalizedGroup,
  NormalizedPreview,
  TemplateConfig,
  ValidationIssue,
  ValueMapping
} from "../utils/csvTemplateTypes";

const csvMappingTemplatesRouter = Router();

const canView = requireAnyPermission(["yield:view", "yield:edit"]);
const canEdit = requirePermission("yield:edit");

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const isCsv = file.mimetype === "text/csv" || file.mimetype === "application/csv" || /\.csv$/i.test(file.originalname);
    if (isCsv) {
      cb(null, true);
      return;
    }
    cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
  }
});

// ---------------------------------------------------------------------------
// Errors — thrown by the exported functions below, translated to HTTP
// status codes by the thin route handlers at the bottom of this file.
// ---------------------------------------------------------------------------

export class TemplateValidationError extends Error {}
export class TemplateNotFoundError extends Error {}
export class TemplateNotCurrentError extends Error {}
export class TemplateConflictError extends Error {}
export class TemplateInUseError extends Error {}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function bufferToDecodedText(buffer: Buffer): string {
  // Mirrors csvGridParser.decodeCsvBuffer's own decoding so the stored
  // raw_text matches exactly what was parsed (BOM stripped, correct charset).
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf-8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  return buffer.toString("utf-8");
}

export type TemplateRow = {
  id: string;
  template_group_id: string;
  organization_id: string;
  name: string;
  version: number;
  is_current: boolean;
  is_active: boolean;
  delimiter: string;
  encoding: string;
  header_row_index: number;
  data_start_row_index: number;
  data_end_row_index: number | null;
  skip_row_indexes: number[];
  blank_row_behavior: BlankRowBehavior;
  fingerprint: unknown;
  fingerprint_hash: string;
  column_mappings: ColumnMapping[];
  fixed_cell_mappings: FixedCellMapping[];
  value_mappings: ValueMapping[];
  rules: ConditionalRowRule[];
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

export function templateRowToConfig(row: TemplateRow): TemplateConfig {
  return {
    delimiter: row.delimiter,
    encoding: row.encoding,
    headerRowIndex: row.header_row_index,
    dataStartRowIndex: row.data_start_row_index,
    dataEndRowIndex: row.data_end_row_index,
    skipRowIndexes: row.skip_row_indexes ?? [],
    blankRowBehavior: row.blank_row_behavior,
    columnMappings: row.column_mappings ?? [],
    fixedCellMappings: row.fixed_cell_mappings ?? [],
    valueMappings: row.value_mappings ?? [],
    rules: row.rules ?? []
  };
}

export function templateRowToSummary(row: TemplateRow) {
  const headers = (row.fingerprint as { headers?: unknown[] } | null)?.headers;
  const columnCount = Array.isArray(headers) ? headers.length : null;
  const delimiterLabel = row.delimiter === "\t" ? "\\t" : row.delimiter;
  const layoutSummary =
    (columnCount !== null ? `${columnCount} column${columnCount === 1 ? "" : "s"}` : "unknown column count") +
    ` · delimiter "${delimiterLabel}" · header row ${row.header_row_index + 1}`;

  return {
    id: row.id,
    templateGroupId: row.template_group_id,
    name: row.name,
    version: row.version,
    isActive: row.is_active,
    isCurrent: row.is_current,
    delimiter: row.delimiter,
    headerRowIndex: row.header_row_index,
    columnCount,
    layoutSummary,
    mappedFieldsCount: (row.column_mappings?.length ?? 0) + (row.fixed_cell_mappings?.length ?? 0),
    rulesCount: row.rules?.length ?? 0,
    valueMappingsCount: row.value_mappings?.length ?? 0,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Resolves a batch of user ids to a display name each (full_name from user
 * metadata, falling back to the email's local part) — same convention as
 * foodSafety/services/actorIdentity.ts's single-user resolveActor, just
 * batched and tolerant of individual lookup failures (a deleted/unknown
 * user shows as "Unknown" rather than failing the whole list).
 */
export async function resolveUserDisplayNames(userIds: string[]): Promise<Map<string, string>> {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  const result = new Map<string, string>();

  await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const { data, error } = await supabase.auth.admin.getUserById(id);
        if (error || !data?.user) {
          result.set(id, "Unknown");
          return;
        }
        const fullName =
          typeof data.user.user_metadata?.full_name === "string" ? data.user.user_metadata.full_name.trim() : "";
        result.set(id, fullName || data.user.email?.split("@")[0] || "Unknown");
      } catch {
        result.set(id, "Unknown");
      }
    })
  );

  return result;
}

export function templateRowToDetail(row: TemplateRow) {
  return {
    ...templateRowToSummary(row),
    dataStartRowIndex: row.data_start_row_index,
    dataEndRowIndex: row.data_end_row_index,
    skipRowIndexes: row.skip_row_indexes ?? [],
    blankRowBehavior: row.blank_row_behavior,
    columnMappings: row.column_mappings ?? [],
    fixedCellMappings: row.fixed_cell_mappings ?? [],
    valueMappings: row.value_mappings ?? [],
    rules: row.rules ?? []
  };
}

export async function loadSizeNameById(organizationId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("yield_sizes").select("id, name").eq("organization_id", organizationId);
  if (error) throw error;
  return new Map((data ?? []).map((s) => [s.id as string, s.name as string]));
}

export async function loadAlreadyImportedLotNumbers(organizationId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("yield_import_runs")
    .select("lot_number")
    .eq("organization_id", organizationId)
    .not("lot_number", "is", null);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.lot_number as string));
}

export async function loadCurrentActiveTemplates(organizationId: string): Promise<TemplateRow[]> {
  const { data, error } = await supabase
    .from("csv_mapping_templates")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_current", true)
    .eq("is_active", true);
  if (error) throw error;
  return (data ?? []) as TemplateRow[];
}

function toFingerprintCandidates(rows: TemplateRow[]): FingerprintCandidate[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    fingerprint: r.fingerprint as FingerprintCandidate["fingerprint"],
    fingerprintHash: r.fingerprint_hash
  }));
}

// ---------------------------------------------------------------------------
// Ingest — upload + grid parse + content-dedup + fingerprint match
// ---------------------------------------------------------------------------

export type ParseAndMatchResult = {
  sourceFileId: string;
  grid: string[][];
  rowCount: number;
  columnCount: number;
  delimiter: string;
  encoding: string;
  hadBom: boolean;
  fingerprintHash: string;
  match: {
    kind: "exact" | "close" | "none";
    templateId: string | null;
    templateName: string | null;
    similarity: number | null;
  };
};

export async function parseAndMatchCsvFile(
  organizationId: string,
  userId: string | null,
  file: { buffer: Buffer; originalname: string }
): Promise<ParseAndMatchResult> {
  const grid = parseCsvGridFromBuffer(file.buffer);
  const fileHash = hashBuffer(file.buffer);

  const { data: existingSourceFile, error: existingErr } = await supabase
    .from("csv_import_source_files")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("file_hash", fileHash)
    .maybeSingle();
  if (existingErr) throw existingErr;

  let sourceFileId = existingSourceFile?.id as string | undefined;

  if (!sourceFileId) {
    const { data: inserted, error: insertErr } = await supabase
      .from("csv_import_source_files")
      .insert({
        organization_id: organizationId,
        file_hash: fileHash,
        filename: file.originalname,
        raw_text: bufferToDecodedText(file.buffer),
        row_count: grid.rowCount,
        column_count: grid.columnCount,
        delimiter: grid.delimiter,
        uploaded_by: userId
      })
      .select("id")
      .single();
    if (insertErr) throw insertErr;
    sourceFileId = inserted.id as string;
  }

  const candidateFingerprint = computeFingerprint(grid.rows, grid.delimiter, 0);
  const candidateHash = computeFingerprintHash(candidateFingerprint);

  const savedTemplates = await loadCurrentActiveTemplates(organizationId);
  const match = matchFingerprint(candidateFingerprint, candidateHash, toFingerprintCandidates(savedTemplates));

  return {
    sourceFileId,
    grid: grid.rows,
    rowCount: grid.rowCount,
    columnCount: grid.columnCount,
    delimiter: grid.delimiter,
    encoding: grid.encoding,
    hadBom: grid.hadBom,
    fingerprintHash: candidateHash,
    match: {
      kind: match.kind,
      templateId: match.template?.id ?? null,
      templateName: match.template?.name ?? null,
      similarity: match.similarity ?? null
    }
  };
}

export type ManualCsvUploadResult =
  | {
      kind: "exact";
      sourceFileId: string;
      templateId: string;
      templateName: string;
      templateVersion: number;
      preview: NormalizedPreview;
    }
  | {
      kind: "ambiguous";
      sourceFileId: string;
      candidates: Array<{ id: string; name: string; version: number }>;
    }
  | {
      kind: "close";
      sourceFileId: string;
      closestTemplateId: string;
      closestTemplateName: string;
      similarity: number | null;
      pendingImportId: string;
    }
  | {
      kind: "none";
      sourceFileId: string;
      pendingImportId: string;
    };

/**
 * The single entry point for "a user just uploaded a CSV and needs to know
 * what to do with it" — used by the Kg Entries manual-upload flow so it
 * never re-implements its own matching/normalization and can never disagree
 * with the CSV Templates tab or the Agent's automated path, which both also
 * go through parseAndMatchCsvFile/buildCsvPreview.
 *
 * "exact" is re-verified for uniqueness here rather than trusting
 * matchFingerprint's first-match — the DB's partial unique index on
 * (organization_id, fingerprint_hash) where is_current and is_active
 * should make more than one impossible, but this is what a saved template
 * gets applied to a real upload, so it re-checks rather than assumes.
 */
export type ExactMatchCandidate = { id: string; name: string; version: number };

/**
 * Pure decision logic, factored out so it's directly unit-testable without
 * a live database: today the partial unique index on
 * (organization_id, fingerprint_hash) where is_current and is_active
 * guarantees this list can never have more than one row — even a direct
 * SQL insert bypassing the app is rejected — so "ambiguous" is a defensive
 * branch for a state the schema currently makes unreachable in practice,
 * not something a real upload can trigger yet. Kept anyway: constraints
 * can change, and silently picking "the first one" would be exactly the
 * kind of guess this whole feature exists to avoid.
 */
export function classifyExactMatches(
  rows: ExactMatchCandidate[]
): { kind: "none" } | { kind: "exact"; template: ExactMatchCandidate } | { kind: "ambiguous"; candidates: ExactMatchCandidate[] } {
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "exact", template: rows[0] };
  return { kind: "ambiguous", candidates: rows };
}

export async function previewManualCsvUpload(
  organizationId: string,
  userId: string | null,
  file: { buffer: Buffer; originalname: string }
): Promise<ManualCsvUploadResult> {
  const parsed = await parseAndMatchCsvFile(organizationId, userId, file);

  if (parsed.match.kind === "exact" && parsed.match.templateId) {
    const { data: exactRows, error: exactErr } = await supabase
      .from("csv_mapping_templates")
      .select("id, name, version")
      .eq("organization_id", organizationId)
      .eq("is_current", true)
      .eq("is_active", true)
      .eq("fingerprint_hash", parsed.fingerprintHash);
    if (exactErr) throw exactErr;

    const classification = classifyExactMatches(
      (exactRows ?? []).map((r) => ({ id: r.id as string, name: r.name as string, version: r.version as number }))
    );

    if (classification.kind === "ambiguous") {
      return { kind: "ambiguous", sourceFileId: parsed.sourceFileId, candidates: classification.candidates };
    }

    const result = await buildCsvPreview(organizationId, { sourceFileId: parsed.sourceFileId, templateId: parsed.match.templateId });
    return {
      kind: "exact",
      sourceFileId: parsed.sourceFileId,
      templateId: parsed.match.templateId,
      templateName: result.templateName ?? parsed.match.templateName ?? "Untitled template",
      templateVersion: result.templateVersion ?? 1,
      preview: result.preview
    };
  }

  // close or none — never silently guess or fall back to the legacy
  // FlowMaster parser. Land it in the same pending-review queue the Agent
  // path already uses, so it's immediately visible in the CSV Templates
  // tab's Pending CSV Imports with "Set up CSV Template" ready to go.
  const pending = await createPendingCsvTemplateImport(
    organizationId,
    parsed.sourceFileId,
    file.originalname,
    parsed.match.kind === "close" ? parsed.match.templateId : null,
    true
  );

  if (parsed.match.kind === "close" && parsed.match.templateId && parsed.match.templateName) {
    return {
      kind: "close",
      sourceFileId: parsed.sourceFileId,
      closestTemplateId: parsed.match.templateId,
      closestTemplateName: parsed.match.templateName,
      similarity: parsed.match.similarity,
      pendingImportId: pending.id
    };
  }

  return { kind: "none", sourceFileId: parsed.sourceFileId, pendingImportId: pending.id };
}

/**
 * Re-fetches an already-stored source file's grid + current fingerprint
 * match, without needing the original bytes again — this is what lets the
 * Template Builder UI resume a pending (e.g. agent-uploaded) file's "Set up
 * CSV template" action from its preserved raw text instead of requiring a
 * fresh upload.
 */
export async function getSourceFileGridAndMatch(
  organizationId: string,
  sourceFileId: string
): Promise<ParseAndMatchResult & { filename: string }> {
  const { data: sourceFile, error } = await supabase
    .from("csv_import_source_files")
    .select("filename, delimiter")
    .eq("id", sourceFileId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!sourceFile) throw new TemplateNotFoundError("Source file not found.");

  const grid = await loadSourceFileGrid(organizationId, sourceFileId, sourceFile.delimiter as string);

  const candidateFingerprint = computeFingerprint(grid.rows, grid.delimiter, 0);
  const candidateHash = computeFingerprintHash(candidateFingerprint);
  const savedTemplates = await loadCurrentActiveTemplates(organizationId);
  const match = matchFingerprint(candidateFingerprint, candidateHash, toFingerprintCandidates(savedTemplates));

  return {
    sourceFileId,
    filename: sourceFile.filename as string,
    grid: grid.rows,
    rowCount: grid.rowCount,
    columnCount: grid.columnCount,
    delimiter: grid.delimiter,
    encoding: "utf-8",
    hadBom: false,
    fingerprintHash: candidateHash,
    match: {
      kind: match.kind,
      templateId: match.template?.id ?? null,
      templateName: match.template?.name ?? null,
      similarity: match.similarity ?? null
    }
  };
}

// ---------------------------------------------------------------------------
// List / detail
// ---------------------------------------------------------------------------

export async function listTemplatesForOrg(organizationId: string): Promise<TemplateRow[]> {
  const { data, error } = await supabase
    .from("csv_mapping_templates")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_current", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as TemplateRow[];
}

export async function getTemplateById(organizationId: string, templateId: string): Promise<TemplateRow | null> {
  const { data, error } = await supabase
    .from("csv_mapping_templates")
    .select("*")
    .eq("id", templateId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data as TemplateRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Create / version / rename / active / duplicate / delete
// ---------------------------------------------------------------------------

export type TemplateWriteInput = {
  name: string;
  sourceFileId: string;
  delimiter: string;
  headerRowIndex: number;
  dataStartRowIndex: number;
  dataEndRowIndex: number | null;
  skipRowIndexes: number[];
  blankRowBehavior: BlankRowBehavior;
  columnMappings: ColumnMapping[];
  fixedCellMappings: FixedCellMapping[];
  valueMappings: ValueMapping[];
  rules: ConditionalRowRule[];
};

export function parseTemplateWriteBody(input: unknown): TemplateWriteInput {
  if (!input || typeof input !== "object") throw new TemplateValidationError("Invalid request body");
  const body = input as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new TemplateValidationError("name is required");

  const sourceFileId = typeof body.sourceFileId === "string" ? body.sourceFileId : "";
  if (!sourceFileId) throw new TemplateValidationError("sourceFileId is required");

  const delimiter = typeof body.delimiter === "string" && body.delimiter ? body.delimiter : ",";
  const headerRowIndex = Number(body.headerRowIndex);
  const dataStartRowIndex = Number(body.dataStartRowIndex);
  if (!Number.isInteger(headerRowIndex) || headerRowIndex < 0) {
    throw new TemplateValidationError("headerRowIndex must be a non-negative integer");
  }
  if (!Number.isInteger(dataStartRowIndex) || dataStartRowIndex < 0) {
    throw new TemplateValidationError("dataStartRowIndex must be a non-negative integer");
  }

  const dataEndRowIndexRaw = body.dataEndRowIndex;
  const dataEndRowIndex =
    dataEndRowIndexRaw === null || dataEndRowIndexRaw === undefined ? null : Number(dataEndRowIndexRaw);
  if (dataEndRowIndex !== null && !Number.isInteger(dataEndRowIndex)) {
    throw new TemplateValidationError("dataEndRowIndex must be an integer or null");
  }

  const skipRowIndexes = Array.isArray(body.skipRowIndexes) ? body.skipRowIndexes.map((n) => Number(n)) : [];
  const blankRowBehavior = body.blankRowBehavior === "stop" ? "stop" : "skip";

  return {
    name,
    sourceFileId,
    delimiter,
    headerRowIndex,
    dataStartRowIndex,
    dataEndRowIndex,
    skipRowIndexes,
    blankRowBehavior,
    columnMappings: Array.isArray(body.columnMappings) ? (body.columnMappings as ColumnMapping[]) : [],
    fixedCellMappings: Array.isArray(body.fixedCellMappings) ? (body.fixedCellMappings as FixedCellMapping[]) : [],
    valueMappings: Array.isArray(body.valueMappings) ? (body.valueMappings as ValueMapping[]) : [],
    rules: Array.isArray(body.rules) ? (body.rules as ConditionalRowRule[]) : []
  };
}

async function computeFingerprintForSourceFile(
  organizationId: string,
  sourceFileId: string,
  delimiter: string,
  headerRowIndex: number
) {
  const { data, error } = await supabase
    .from("csv_import_source_files")
    .select("raw_text")
    .eq("id", sourceFileId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new TemplateNotFoundError("Referenced source file was not found.");

  const grid = parseCsvGrid(data.raw_text as string, delimiter);
  const fingerprint = computeFingerprint(grid.rows, delimiter, headerRowIndex);
  return { fingerprint, fingerprintHash: computeFingerprintHash(fingerprint), grid };
}

const templateWriteLocks = new Map<string, Promise<void>>();

async function withTemplateWriteLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = templateWriteLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  templateWriteLocks.set(key, previous.then(() => current).catch(() => current));

  await previous;

  try {
    return await task();
  } finally {
    release?.();
    if (templateWriteLocks.get(key) === current) {
      templateWriteLocks.delete(key);
    }
  }
}

export async function createTemplate(organizationId: string, userId: string, body: TemplateWriteInput): Promise<TemplateRow> {
  const { fingerprint, fingerprintHash } = await computeFingerprintForSourceFile(
    organizationId,
    body.sourceFileId,
    body.delimiter,
    body.headerRowIndex
  );

  return withTemplateWriteLock(`${organizationId}:${fingerprintHash}`, async () => {
    const { data: existingCurrent, error: existingCurrentError } = await supabase
      .from("csv_mapping_templates")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("fingerprint_hash", fingerprintHash)
      .eq("is_current", true)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (existingCurrentError) throw existingCurrentError;
    if (existingCurrent) {
      throw new TemplateConflictError("An active template already exists for this exact CSV layout.");
    }

    // Deliberately does NOT clear other is_current rows sharing this
    // fingerprint_hash: a disabled (is_active=false) template can
    // legitimately stay is_current=true forever (setTemplateActive never
    // touches is_current) as the pointer to its own version history. It
    // never conflicts with the partial unique index (which only covers
    // is_current AND is_active rows) and creating a brand-new, unrelated
    // template_group here must never silently flip that unrelated group's
    // current-version pointer as a side effect.
    const { data, error } = await supabase
      .from("csv_mapping_templates")
      .insert({
        template_group_id: randomUUID(),
        organization_id: organizationId,
        name: body.name,
        version: 1,
        is_current: true,
        is_active: true,
        delimiter: body.delimiter,
        encoding: "utf-8",
        header_row_index: body.headerRowIndex,
        data_start_row_index: body.dataStartRowIndex,
        data_end_row_index: body.dataEndRowIndex,
        skip_row_indexes: body.skipRowIndexes,
        blank_row_behavior: body.blankRowBehavior,
        fingerprint,
        fingerprint_hash: fingerprintHash,
        column_mappings: body.columnMappings,
        fixed_cell_mappings: body.fixedCellMappings,
        value_mappings: body.valueMappings,
        rules: body.rules,
        created_by: userId,
        updated_by: userId
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === "23505") {
        throw new TemplateConflictError("An active template already exists for this exact CSV layout.");
      }
      throw error;
    }

    return data as TemplateRow;
  });
}

// Non-atomic by necessity (no multi-table transaction available through
// supabase-js without an RPC): the old row is flipped to non-current FIRST
// so the partial unique index on (org, fingerprint_hash) doesn't block the
// new version's insert when the layout — and therefore the fingerprint —
// is unchanged, which is the common case for an edit (mappings/rules
// changed, delimiter/header row usually didn't). If the insert fails, the
// old row's is_current is best-effort restored rather than leaving the
// template with zero current versions.
export async function createTemplateVersion(
  organizationId: string,
  userId: string,
  templateId: string,
  body: TemplateWriteInput
): Promise<TemplateRow> {
  const existing = await getTemplateById(organizationId, templateId);
  if (!existing) throw new TemplateNotFoundError("Template not found.");
  if (!existing.is_current) throw new TemplateNotCurrentError("Only the current version of a template can be edited.");

  const { fingerprint, fingerprintHash } = await computeFingerprintForSourceFile(
    organizationId,
    body.sourceFileId,
    body.delimiter,
    body.headerRowIndex
  );

  return withTemplateWriteLock(`${organizationId}:${existing.template_group_id}`, async () => {
    const live = await getTemplateById(organizationId, templateId);
    if (!live || !live.is_current) {
      throw new TemplateNotCurrentError("Only the current version of a template can be edited.");
    }

    const { data: currentTwin, error: currentTwinError } = await supabase
      .from("csv_mapping_templates")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("template_group_id", existing.template_group_id)
      .eq("is_current", true)
      .neq("id", templateId)
      .limit(1)
      .maybeSingle();

    if (currentTwinError) throw currentTwinError;
    if (currentTwin) {
      throw new TemplateConflictError("An active template already exists for this exact CSV layout.");
    }

    const { error: demoteErr } = await supabase
      .from("csv_mapping_templates")
      .update({ is_current: false, updated_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("template_group_id", existing.template_group_id)
      .eq("is_current", true);

    if (demoteErr) throw demoteErr;

    const { data: inserted, error: insertErr } = await supabase
      .from("csv_mapping_templates")
      .insert({
        template_group_id: existing.template_group_id,
        organization_id: organizationId,
        name: body.name,
        version: existing.version + 1,
        is_current: true,
        is_active: true,
        delimiter: body.delimiter,
        encoding: "utf-8",
        header_row_index: body.headerRowIndex,
        data_start_row_index: body.dataStartRowIndex,
        data_end_row_index: body.dataEndRowIndex,
        skip_row_indexes: body.skipRowIndexes,
        blank_row_behavior: body.blankRowBehavior,
        fingerprint,
        fingerprint_hash: fingerprintHash,
        column_mappings: body.columnMappings,
        fixed_cell_mappings: body.fixedCellMappings,
        value_mappings: body.valueMappings,
        rules: body.rules,
        created_by: existing.created_by,
        updated_by: userId
      })
      .select("*")
      .single();

    if (insertErr) {
      await supabase
        .from("csv_mapping_templates")
        .update({ is_current: true, updated_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("id", templateId);
      if (insertErr.code === "23505") {
        throw new TemplateConflictError("An active template already exists for this exact CSV layout.");
      }
      throw insertErr;
    }

    return inserted as TemplateRow;
  });
}

export async function renameTemplate(organizationId: string, userId: string, templateId: string, name: string): Promise<TemplateRow> {
  if (!name.trim()) throw new TemplateValidationError("name is required");

  const { data, error } = await supabase
    .from("csv_mapping_templates")
    .update({ name: name.trim(), updated_by: userId, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new TemplateNotFoundError("Template not found.");
  return data as TemplateRow;
}

export async function setTemplateActive(organizationId: string, userId: string, templateId: string, isActive: boolean): Promise<TemplateRow> {
  const { data, error } = await supabase
    .from("csv_mapping_templates")
    .update({ is_active: isActive, updated_by: userId, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new TemplateConflictError("An active template already exists for this exact CSV layout.");
    }
    throw error;
  }
  if (!data) throw new TemplateNotFoundError("Template not found.");
  return data as TemplateRow;
}

export async function duplicateTemplate(
  organizationId: string,
  userId: string,
  templateId: string,
  name: string | null
): Promise<TemplateRow> {
  const source = await getTemplateById(organizationId, templateId);
  if (!source) throw new TemplateNotFoundError("Template not found.");

  const { data, error } = await supabase
    .from("csv_mapping_templates")
    .insert({
      template_group_id: randomUUID(),
      organization_id: organizationId,
      name: name ?? `${source.name} (copy)`,
      version: 1,
      is_current: true,
      is_active: true,
      delimiter: source.delimiter,
      encoding: source.encoding,
      header_row_index: source.header_row_index,
      data_start_row_index: source.data_start_row_index,
      data_end_row_index: source.data_end_row_index,
      skip_row_indexes: source.skip_row_indexes,
      blank_row_behavior: source.blank_row_behavior,
      // A duplicate is a starting point for a DIFFERENT layout — it must
      // not silently auto-match future uploads of the original layout. The
      // fingerprint is copied for display (column count etc.) but the hash
      // is made deliberately non-colliding so it can never auto-match
      // until the user re-runs it through parse-grid and saves for real.
      fingerprint: source.fingerprint,
      fingerprint_hash: `${source.fingerprint_hash}::duplicate:${randomUUID()}`,
      column_mappings: source.column_mappings,
      fixed_cell_mappings: source.fixed_cell_mappings,
      value_mappings: source.value_mappings,
      rules: source.rules,
      created_by: userId,
      updated_by: userId
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as TemplateRow;
}

export async function deleteTemplateIfUnused(organizationId: string, templateId: string): Promise<void> {
  const [{ count: pendingCount, error: pendingErr }, { count: runCount, error: runErr }] = await Promise.all([
    supabase
      .from("agent_pending_imports")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("csv_mapping_template_id", templateId),
    supabase
      .from("yield_import_runs")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("csv_mapping_template_id", templateId)
  ]);

  if (pendingErr) throw pendingErr;
  if (runErr) throw runErr;

  if ((pendingCount ?? 0) > 0 || (runCount ?? 0) > 0) {
    throw new TemplateInUseError("This template has been used for imports and cannot be deleted. Disable it instead.");
  }

  const { error } = await supabase.from("csv_mapping_templates").delete().eq("id", templateId).eq("organization_id", organizationId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type PreviewInput = {
  sourceFileId: string;
  templateId?: string;
  draftConfig?: Partial<TemplateConfig>;
};

export function parsePreviewBody(input: unknown): PreviewInput {
  if (!input || typeof input !== "object") throw new TemplateValidationError("Invalid request body");
  const body = input as Record<string, unknown>;
  const sourceFileId = typeof body.sourceFileId === "string" ? body.sourceFileId : "";
  if (!sourceFileId) throw new TemplateValidationError("sourceFileId is required");

  return {
    sourceFileId,
    templateId: typeof body.templateId === "string" ? body.templateId : undefined,
    draftConfig: (body.draftConfig as Partial<TemplateConfig> | undefined) ?? undefined
  };
}

async function loadSourceFileGrid(organizationId: string, sourceFileId: string, delimiter?: string) {
  const { data, error } = await supabase
    .from("csv_import_source_files")
    .select("raw_text")
    .eq("id", sourceFileId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new TemplateNotFoundError("Referenced source file was not found.");

  return parseCsvGrid(data.raw_text as string, delimiter);
}

export type VarietyMatch = { id: string; name: string };

/** Active varieties keyed by trimmed, lowercased name — the engine only ever produces raw variety text, never an id, so this is how every group's varietyRaw gets resolved to a real record. */
export async function loadActiveVarietyByName(organizationId: string): Promise<Map<string, VarietyMatch>> {
  const { data, error } = await supabase
    .from("varieties")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("status", "active");
  if (error) throw error;

  const map = new Map<string, VarietyMatch>();
  for (const v of data ?? []) {
    map.set((v.name as string).trim().toLowerCase(), { id: v.id as string, name: v.name as string });
  }
  return map;
}

function checkGroupVarietyIssues(
  groups: NormalizedGroup[],
  activeVarietyByName: Map<string, VarietyMatch>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const group of groups) {
    // A missing varietyRaw is already flagged by the engine's own
    // validateNormalizedPreview (code: variety_unresolved) — this only
    // covers the case where raw text IS present but doesn't match any
    // real, active organization variety.
    if (!group.varietyRaw) continue;
    if (!activeVarietyByName.has(group.varietyRaw.trim().toLowerCase())) {
      issues.push({
        code: "variety_unresolved",
        message: `No active variety matches "${group.varietyRaw}".`,
        groupKey: group.groupKey
      });
    }
  }
  return issues;
}

export type PreviewResult = {
  preview: NormalizedPreview;
  templateId: string | null;
  templateName: string | null;
  templateVersion: number | null;
  layoutMismatch: boolean;
};

export type SourceValueOverrideRow = {
  id: string;
  source_field: "size_label" | "market_grade";
  raw_value: string;
  action: "map" | "ignore" | "distribute";
  target_size_id: string | null;
  distribute_size_ids: string[] | null;
};

/**
 * "Pending data only" label resolutions for one source file — additive on
 * top of a matched template's own value_mappings, never written into the
 * template. An override always wins over the template's own mapping for the
 * same (source_field, raw_value) pair, so re-resolving a label for this
 * source alone is possible even if the template already has (a different)
 * mapping for it.
 */
export async function loadSourceValueOverrides(
  organizationId: string,
  sourceFileId: string
): Promise<SourceValueOverrideRow[]> {
  const { data, error } = await supabase
    .from("csv_source_value_overrides")
    .select("id, source_field, raw_value, action, target_size_id, distribute_size_ids")
    .eq("organization_id", organizationId)
    .eq("source_file_id", sourceFileId);
  if (error) throw error;
  return (data ?? []) as SourceValueOverrideRow[];
}

export function applyValueOverrides(config: TemplateConfig, overrides: SourceValueOverrideRow[]): TemplateConfig {
  if (overrides.length === 0) return config;

  const overrideMappings: ValueMapping[] = overrides.map((o) => ({
    sourceField: o.source_field,
    rawValue: o.raw_value,
    action: o.action,
    targetSizeId: o.target_size_id ?? undefined,
    distributeSizeIds: o.distribute_size_ids ?? undefined
  }));

  const overrideKeys = new Set(overrideMappings.map((m) => `${m.sourceField}:${m.rawValue.trim().toLowerCase()}`));
  const baseMappings = config.valueMappings.filter(
    (m) => !overrideKeys.has(`${m.sourceField}:${m.rawValue.trim().toLowerCase()}`)
  );

  return { ...config, valueMappings: [...baseMappings, ...overrideMappings] };
}

export async function buildCsvPreview(organizationId: string, body: PreviewInput): Promise<PreviewResult> {
  let config: TemplateConfig;
  let layoutMismatch = false;
  let templateRow: TemplateRow | null = null;

  if (body.templateId) {
    templateRow = await getTemplateById(organizationId, body.templateId);
    if (!templateRow) throw new TemplateNotFoundError("Template not found.");

    const overrides = await loadSourceValueOverrides(organizationId, body.sourceFileId);
    config = applyValueOverrides(templateRowToConfig(templateRow), overrides);

    const grid = await loadSourceFileGrid(organizationId, body.sourceFileId, templateRow.delimiter);
    const candidateFingerprint = computeFingerprint(grid.rows, templateRow.delimiter, templateRow.header_row_index);
    const candidateHash = computeFingerprintHash(candidateFingerprint);
    layoutMismatch = candidateHash !== templateRow.fingerprint_hash;
  } else if (body.draftConfig) {
    config = {
      delimiter: body.draftConfig.delimiter ?? ",",
      encoding: body.draftConfig.encoding ?? "utf-8",
      headerRowIndex: body.draftConfig.headerRowIndex ?? 0,
      dataStartRowIndex: body.draftConfig.dataStartRowIndex ?? 1,
      dataEndRowIndex: body.draftConfig.dataEndRowIndex ?? null,
      skipRowIndexes: body.draftConfig.skipRowIndexes ?? [],
      blankRowBehavior: body.draftConfig.blankRowBehavior ?? "skip",
      columnMappings: body.draftConfig.columnMappings ?? [],
      fixedCellMappings: body.draftConfig.fixedCellMappings ?? [],
      valueMappings: body.draftConfig.valueMappings ?? [],
      rules: body.draftConfig.rules ?? []
    };
  } else {
    throw new TemplateValidationError("Either templateId or draftConfig is required.");
  }

  const grid = await loadSourceFileGrid(organizationId, body.sourceFileId, config.delimiter);

  const [sizeNameById, alreadyImportedLotNumbers] = await Promise.all([
    loadSizeNameById(organizationId),
    loadAlreadyImportedLotNumbers(organizationId)
  ]);

  const context: EngineContext = { sizeNameById, alreadyImportedLotNumbers };
  const preview = normalizeCsvWithTemplate(grid.rows, config, context);

  const activeVarietyByName = await loadActiveVarietyByName(organizationId);
  const varietyIssues = checkGroupVarietyIssues(preview.groups, activeVarietyByName);

  const allIssues: ValidationIssue[] = [
    ...(layoutMismatch
      ? [
          {
            code: "layout_mismatch" as const,
            message: "The uploaded file's structure no longer matches this template. Please review before importing."
          }
        ]
      : []),
    ...preview.validationIssues,
    ...varietyIssues
  ];

  const finalPreview: NormalizedPreview = {
    ...preview,
    validationIssues: allIssues,
    canImport: allIssues.length === 0
  };

  return {
    preview: finalPreview,
    templateId: templateRow?.id ?? null,
    templateName: templateRow?.name ?? null,
    templateVersion: templateRow?.version ?? null,
    layoutMismatch
  };
}

// ---------------------------------------------------------------------------
// Pending-import queue (data_source_type = 'csv_template')
//
// Deliberately additive, not a modification of agentPendingImports.ts: its
// PATCH/DELETE routes are already generic over any agent_pending_imports
// row (id + organization_id filtered, no data_source_type branching) and
// keep working unchanged for csv_template rows. Its GET route, however,
// rebuilds previews via buildPreviewFile, which only understands FlowMaster
// CSV/PDF shapes — so csv_template rows get their own GET/list here instead,
// rebuilt via buildCsvPreview (the engine above), reading the same
// preserved raw CSV text so a pending file can always be reopened and
// reprocessed against current template/rule state without re-upload.
//
// ---------------------------------------------------------------------------

export type PendingCsvTemplateRow = {
  id: string;
  organization_id: string;
  source_filename: string;
  source_file_id: string | null;
  csv_mapping_template_id: string | null;
  needs_template: boolean;
  uploaded_at: string;
};

export async function createPendingCsvTemplateImport(
  organizationId: string,
  sourceFileId: string,
  sourceFilename: string,
  templateId: string | null,
  needsTemplate: boolean
): Promise<PendingCsvTemplateRow> {
  const { data, error } = await supabase
    .from("agent_pending_imports")
    .insert({
      organization_id: organizationId,
      source_filename: sourceFilename,
      data_source_type: "csv_template",
      source_file_id: sourceFileId,
      csv_mapping_template_id: templateId,
      needs_template: needsTemplate,
      source_type: "browser"
    })
    .select("id, organization_id, source_filename, source_file_id, csv_mapping_template_id, needs_template, uploaded_at")
    .single();

  if (error) throw error;
  return data as PendingCsvTemplateRow;
}

export type PendingCsvTemplatePreviewItem = {
  id: string;
  sourceFilename: string;
  sourceFileId: string | null;
  uploadedAt: string;
  needsTemplate: boolean;
  templateId: string | null;
  templateName: string | null;
  templateVersion: number | null;
  /** Set only for needsTemplate rows: whether the layout closely resembles a saved template (requires review) or matched nothing at all. Recomputed live, not stored, so it always reflects the org's current templates. */
  matchKind: "close" | "none" | null;
  preview: NormalizedPreview | null;
  error: string | null;
};

/** Lists every csv_template pending row for the org, each reprocessed live from its preserved raw text (never trusting stale stored columns). */
export async function listPendingCsvTemplateImports(organizationId: string): Promise<PendingCsvTemplatePreviewItem[]> {
  const { data, error } = await supabase
    .from("agent_pending_imports")
    .select("id, source_filename, source_file_id, csv_mapping_template_id, needs_template, uploaded_at")
    .eq("organization_id", organizationId)
    .eq("data_source_type", "csv_template")
    .order("uploaded_at", { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as PendingCsvTemplateRow[];
  const items: PendingCsvTemplatePreviewItem[] = [];

  for (const row of rows) {
    if (!row.source_file_id || !row.csv_mapping_template_id || row.needs_template) {
      let matchKind: "close" | "none" | null = null;
      if (row.source_file_id) {
        try {
          const sourceGrid = await loadSourceFileGrid(organizationId, row.source_file_id);
          const candidateFingerprint = computeFingerprint(sourceGrid.rows, sourceGrid.delimiter, 0);
          const candidateHash = computeFingerprintHash(candidateFingerprint);
          const savedTemplates = await loadCurrentActiveTemplates(organizationId);
          const match = matchFingerprint(candidateFingerprint, candidateHash, toFingerprintCandidates(savedTemplates));
          matchKind = match.kind === "exact" ? null : match.kind;
        } catch {
          // Non-fatal — the UI just won't show a close/none distinction for this row.
        }
      }

      items.push({
        id: row.id,
        sourceFilename: row.source_filename,
        sourceFileId: row.source_file_id,
        uploadedAt: row.uploaded_at,
        needsTemplate: true,
        templateId: row.csv_mapping_template_id,
        templateName: null,
        templateVersion: null,
        matchKind,
        preview: null,
        error: null
      });
      continue;
    }

    try {
      const result = await buildCsvPreview(organizationId, {
        sourceFileId: row.source_file_id,
        templateId: row.csv_mapping_template_id
      });
      items.push({
        id: row.id,
        sourceFilename: row.source_filename,
        sourceFileId: row.source_file_id,
        uploadedAt: row.uploaded_at,
        needsTemplate: false,
        templateId: row.csv_mapping_template_id,
        templateName: result.templateName,
        templateVersion: result.templateVersion,
        matchKind: null,
        preview: result.preview,
        error: null
      });
    } catch (err) {
      items.push({
        id: row.id,
        sourceFilename: row.source_filename,
        sourceFileId: row.source_file_id,
        uploadedAt: row.uploaded_at,
        needsTemplate: false,
        templateId: row.csv_mapping_template_id,
        templateName: null,
        templateVersion: null,
        matchKind: null,
        preview: null,
        error: err instanceof Error ? err.message : "Failed to rebuild preview."
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Weekly variety cards — presentation/approval grouping over the SAME
// per-source previews above (buildCsvPreview), bucketed by (organization,
// resolved variety, iso year, iso week). No aggregation math happens
// client-side: every kg/AFW/reconciliation figure a card shows is either a
// direct sum of, or (for AFW) recomputed straight from, the row-level data
// the server's own engine already produced for the final import. Rows that
// still need a template (needs_template=true) are listed separately since
// they have no variety/week to bucket by yet.
// ---------------------------------------------------------------------------

export type UnmatchedPendingItem = {
  id: string;
  sourceFilename: string;
  sourceFileId: string | null;
  uploadedAt: string;
  matchKind: "close" | "none" | null;
  error: string | null;
};

export type WeeklyCardsResult = {
  cards: WeeklyCard[];
  unmatched: UnmatchedPendingItem[];
};

export async function listPendingCsvTemplateWeeklyCards(organizationId: string): Promise<WeeklyCardsResult> {
  const { data, error } = await supabase
    .from("agent_pending_imports")
    .select("id, source_filename, source_file_id, csv_mapping_template_id, needs_template, uploaded_at")
    .eq("organization_id", organizationId)
    .eq("data_source_type", "csv_template")
    .order("uploaded_at", { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as PendingCsvTemplateRow[];
  const entries: PendingSourceEntry[] = [];
  const unmatched: UnmatchedPendingItem[] = [];

  for (const row of rows) {
    if (!row.source_file_id || !row.csv_mapping_template_id || row.needs_template) {
      let matchKind: "close" | "none" | null = null;
      if (row.source_file_id) {
        try {
          const sourceGrid = await loadSourceFileGrid(organizationId, row.source_file_id);
          const candidateFingerprint = computeFingerprint(sourceGrid.rows, sourceGrid.delimiter, 0);
          const candidateHash = computeFingerprintHash(candidateFingerprint);
          const savedTemplates = await loadCurrentActiveTemplates(organizationId);
          const match = matchFingerprint(candidateFingerprint, candidateHash, toFingerprintCandidates(savedTemplates));
          matchKind = match.kind === "exact" ? null : match.kind;
        } catch {
          // Non-fatal — the UI just won't show a close/none distinction for this row.
        }
      }
      unmatched.push({
        id: row.id,
        sourceFilename: row.source_filename,
        sourceFileId: row.source_file_id,
        uploadedAt: row.uploaded_at,
        matchKind,
        error: null
      });
      continue;
    }

    try {
      const result = await buildCsvPreview(organizationId, {
        sourceFileId: row.source_file_id,
        templateId: row.csv_mapping_template_id
      });
      entries.push({
        pendingImportId: row.id,
        sourceFileId: row.source_file_id,
        sourceFilename: row.source_filename,
        uploadedAt: row.uploaded_at,
        templateId: row.csv_mapping_template_id,
        templateName: result.templateName,
        templateVersion: result.templateVersion,
        layoutMismatch: result.layoutMismatch,
        preview: result.preview
      });
    } catch (err) {
      unmatched.push({
        id: row.id,
        sourceFilename: row.source_filename,
        sourceFileId: row.source_file_id,
        uploadedAt: row.uploaded_at,
        matchKind: null,
        error: err instanceof Error ? err.message : "Failed to rebuild preview."
      });
    }
  }

  const activeVarietyByName = await loadActiveVarietyByName(organizationId);
  const cards = buildWeeklyCards(organizationId, entries, activeVarietyByName);

  return { cards, unmatched };
}

// ---------------------------------------------------------------------------
// Final import — writes yield_entries / yield_entry_daily_breakdown /
// yield_import_runs. Mirrors pdfImport.ts's create/append semantics
// (merge-on-append, kg-weighted... actually simple-replace here since a CSV
// template group is a single cohesive batch, see note below) but is a
// fully independent implementation against the new engine's output shape.
//
// Server-side revalidation: the client submits the exact NormalizedGroup it
// showed the user as `approvedGroup`, but the write is driven entirely by a
// FRESH re-parse of the stored source file through the FRESH engine run —
// `approvedGroup` is only compared against that fresh result (groupsMatch)
// to detect a stale/tampered preview. The database is never written from
// client-supplied numbers.
// ---------------------------------------------------------------------------

export type CsvTemplateImportInput = {
  sourceFileId: string;
  templateId: string;
  groupKey: string;
  approvedGroup: NormalizedGroup;
};

export type CsvTemplateImportResult = {
  mode: "create" | "append";
  entryId: string;
  varietyId: string;
};

function groupsMatch(fresh: NormalizedGroup, approved: NormalizedGroup): boolean {
  const EPS = 0.01;
  if (fresh.varietyRaw !== approved.varietyRaw) return false;
  if (fresh.packedDate !== approved.packedDate) return false;
  if (fresh.isoYear !== approved.isoYear || fresh.isoWeek !== approved.isoWeek) return false;
  if (fresh.lotNumber !== approved.lotNumber) return false;
  if (Math.abs(fresh.reconciliation.recognizedSizeKg - approved.reconciliation.recognizedSizeKg) > EPS) return false;

  const freshKeys = Object.keys(fresh.sizeKg).sort();
  const approvedKeys = Object.keys(approved.sizeKg).sort();
  if (freshKeys.length !== approvedKeys.length) return false;
  for (let i = 0; i < freshKeys.length; i += 1) {
    if (freshKeys[i] !== approvedKeys[i]) return false;
    if (Math.abs(fresh.sizeKg[freshKeys[i]] - approved.sizeKg[approvedKeys[i]]) > EPS) return false;
  }

  return true;
}

async function loadVarietyForCalc(organizationId: string, varietyId: string): Promise<{ id: string; area_m2: number; case_kg: number }> {
  const { data, error } = await supabase
    .from("varieties")
    .select("id, area_m2, case_kg")
    .eq("id", varietyId)
    .eq("organization_id", organizationId)
    .single();
  if (error || !data) throw new TemplateValidationError("Selected variety was not found.");
  return data as { id: string; area_m2: number; case_kg: number };
}

/** Finds an existing yield_sizes row by case-insensitive name, or creates one — for value mappings using the "create" action, which store only a name until the size is actually needed at import time. */
async function ensureYieldSizeId(organizationId: string, name: string, knownIds: Map<string, string>): Promise<string> {
  const existingId = knownIds.get(name.trim().toLowerCase());
  if (existingId) return existingId;

  const { data: existingRows, error: existingErr } = await supabase
    .from("yield_sizes")
    .select("id, name")
    .eq("organization_id", organizationId);
  if (existingErr) throw existingErr;

  const match = (existingRows ?? []).find((s) => (s.name as string).trim().toLowerCase() === name.trim().toLowerCase());
  if (match) {
    knownIds.set(name.trim().toLowerCase(), match.id as string);
    return match.id as string;
  }

  const { data: created, error: createErr } = await supabase
    .from("yield_sizes")
    .insert({ organization_id: organizationId, name: name.trim(), sort_order: 0, status: "active" })
    .select("id")
    .single();
  if (createErr) throw createErr;

  knownIds.set(name.trim().toLowerCase(), created.id as string);
  return created.id as string;
}

function calculateGroupTotals(sizeKgById: Record<string, number>, variety: { area_m2: number; case_kg: number }) {
  const total_kg = Object.values(sizeKgById).reduce((sum, v) => sum + v, 0);
  const kg_per_m2 = variety.area_m2 > 0 ? total_kg / variety.area_m2 : 0;
  const total_cases = variety.case_kg > 0 ? total_kg / variety.case_kg : 0;
  return { total_kg, kg_per_m2, total_cases };
}

export async function importCsvTemplateGroup(
  organizationId: string,
  userId: string,
  input: CsvTemplateImportInput
): Promise<CsvTemplateImportResult> {
  const templateRow = await getTemplateById(organizationId, input.templateId);
  if (!templateRow) throw new TemplateNotFoundError("Template not found.");

  const overrides = await loadSourceValueOverrides(organizationId, input.sourceFileId);
  const config = applyValueOverrides(templateRowToConfig(templateRow), overrides);
  const grid = await loadSourceFileGrid(organizationId, input.sourceFileId, templateRow.delimiter);

  const [sizeNameById, alreadyImportedLotNumbers, activeVarietyByName] = await Promise.all([
    loadSizeNameById(organizationId),
    loadAlreadyImportedLotNumbers(organizationId),
    loadActiveVarietyByName(organizationId)
  ]);

  const context: EngineContext = { sizeNameById, alreadyImportedLotNumbers };
  const freshPreview = normalizeCsvWithTemplate(grid.rows, config, context);

  const freshGroup = freshPreview.groups.find((g) => g.groupKey === input.groupKey);
  if (!freshGroup) {
    throw new TemplateValidationError("The requested group was not found in a fresh re-parse of the source file.");
  }

  if (!groupsMatch(freshGroup, input.approvedGroup)) {
    throw new TemplateConflictError("The preview has changed since it was approved. Please re-review before importing.");
  }

  const groupIssues = [
    ...freshPreview.validationIssues.filter((i) => !i.groupKey || i.groupKey === input.groupKey),
    ...checkGroupVarietyIssues([freshGroup], activeVarietyByName)
  ];
  if (groupIssues.length > 0) {
    throw new TemplateValidationError(`Cannot import: ${groupIssues.map((i) => i.message).join(" ")}`);
  }

  const varietyMatch = activeVarietyByName.get((freshGroup.varietyRaw ?? "").trim().toLowerCase());
  if (!varietyMatch) throw new TemplateValidationError(`No active variety matches "${freshGroup.varietyRaw}".`);
  if (!freshGroup.packedDate) throw new TemplateValidationError("Packed date could not be resolved for this group.");
  if (freshGroup.isoYear === null || freshGroup.isoWeek === null) {
    throw new TemplateValidationError("Year/week could not be resolved for this group.");
  }

  // Dedup claim — the group's real lot number if the template maps one,
  // else a deterministic pseudo-lot derived from the group's own content
  // so re-importing the exact same synthetic group is still blocked.
  const claimLotNumber =
    freshGroup.lotNumber ?? `csvtpl-${createHash("sha1").update(freshGroup.groupKey).digest("hex").slice(0, 16)}`;

  const { error: claimErr } = await supabase.from("yield_import_runs").insert({
    organization_id: organizationId,
    lot_number: claimLotNumber,
    variety_id: varietyMatch.id,
    iso_year: freshGroup.isoYear,
    iso_week: freshGroup.isoWeek,
    source_filename: templateRow.name,
    created_by: userId,
    csv_mapping_template_id: templateRow.id,
    source_file_id: input.sourceFileId
  });

  if (claimErr) {
    if (claimErr.code === "23505") {
      throw new TemplateConflictError(`This data (lot ${claimLotNumber}) has already been imported.`);
    }
    throw claimErr;
  }

  try {
    const varietyForCalc = await loadVarietyForCalc(organizationId, varietyMatch.id);
    const knownSizeIds = new Map(Array.from(sizeNameById.entries()).map(([id, name]) => [name.trim().toLowerCase(), id]));

    const sizeKgById: Record<string, number> = {};
    for (const [name, kg] of Object.entries(freshGroup.sizeKg)) {
      const id = await ensureYieldSizeId(organizationId, name, knownSizeIds);
      sizeKgById[id] = (sizeKgById[id] ?? 0) + kg;
    }

    const { data: existingEntry, error: existingErr } = await supabase
      .from("yield_entries")
      .select("id, size_kg")
      .eq("organization_id", organizationId)
      .eq("variety_id", varietyMatch.id)
      .eq("year", freshGroup.isoYear)
      .eq("week", freshGroup.isoWeek)
      .maybeSingle();
    if (existingErr) throw existingErr;

    let entryId: string;
    let mode: "create" | "append";

    if (existingEntry) {
      mode = "append";
      const mergedSizeKg: Record<string, number> = { ...(existingEntry.size_kg as Record<string, number>) };
      for (const [id, kg] of Object.entries(sizeKgById)) {
        mergedSizeKg[id] = (mergedSizeKg[id] ?? 0) + kg;
      }
      const mergedTotals = calculateGroupTotals(mergedSizeKg, varietyForCalc);

      const { data: updated, error: updateErr } = await supabase
        .from("yield_entries")
        .update({
          size_kg: mergedSizeKg,
          average_fruit_weight_g: freshGroup.averageFruitWeightG,
          ...mergedTotals,
          updated_at: new Date().toISOString()
        })
        .eq("id", existingEntry.id)
        .select("id")
        .single();
      if (updateErr) throw updateErr;
      entryId = updated.id as string;
    } else {
      mode = "create";
      const totals = calculateGroupTotals(sizeKgById, varietyForCalc);
      const { data: created, error: createErr } = await supabase
        .from("yield_entries")
        .insert({
          organization_id: organizationId,
          variety_id: varietyMatch.id,
          year: freshGroup.isoYear,
          week: freshGroup.isoWeek,
          packed_date: freshGroup.packedDate,
          size_kg: sizeKgById,
          average_fruit_weight_g: freshGroup.averageFruitWeightG,
          ...totals
        })
        .select("id")
        .single();
      if (createErr) throw createErr;
      entryId = created.id as string;
    }

    const { error: breakdownErr } = await supabase.from("yield_entry_daily_breakdown").insert({
      organization_id: organizationId,
      yield_entry_id: entryId,
      packed_date: freshGroup.packedDate,
      size_kg: sizeKgById,
      total_kg: Object.values(sizeKgById).reduce((sum, v) => sum + v, 0),
      average_fruit_weight_g: freshGroup.averageFruitWeightG
    });
    if (breakdownErr) {
      // Non-fatal (matches pdfImport.ts's own tolerance here): the weekly
      // total is already correct, this only affects the per-day breakdown
      // display, and the failure is logged for follow-up.
      console.error("csv-templates import: daily breakdown insert failed:", breakdownErr);
    }

    await supabase
      .from("agent_pending_imports")
      .delete()
      .eq("organization_id", organizationId)
      .eq("source_file_id", input.sourceFileId);

    return { mode, entryId, varietyId: varietyMatch.id };
  } catch (error) {
    // Release the claim so this data can be retried.
    await supabase
      .from("yield_import_runs")
      .delete()
      .eq("organization_id", organizationId)
      .eq("lot_number", claimLotNumber);
    throw error;
  }
}

export function parseImportBody(input: unknown): CsvTemplateImportInput {
  if (!input || typeof input !== "object") throw new TemplateValidationError("Invalid request body");
  const body = input as Record<string, unknown>;

  const sourceFileId = typeof body.sourceFileId === "string" ? body.sourceFileId : "";
  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  const groupKey = typeof body.groupKey === "string" ? body.groupKey : "";
  if (!sourceFileId) throw new TemplateValidationError("sourceFileId is required");
  if (!templateId) throw new TemplateValidationError("templateId is required");
  if (!groupKey) throw new TemplateValidationError("groupKey is required");
  if (!body.approvedGroup || typeof body.approvedGroup !== "object") {
    throw new TemplateValidationError("approvedGroup is required");
  }

  return { sourceFileId, templateId, groupKey, approvedGroup: body.approvedGroup as NormalizedGroup };
}

// ---------------------------------------------------------------------------
// Resolve unresolved labels — either "pending data only" (an additive
// csv_source_value_overrides row per affected source, never touching the
// template) or "save for future imports" (one new template version
// containing every submitted resolution, per the requirement that a batch
// of resolutions must never produce one version per label).
// ---------------------------------------------------------------------------

export type ResolveLabelInput = {
  sourceField: "size_label" | "market_grade";
  rawValue: string;
  action: "map" | "ignore" | "distribute" | "create" | "unresolved";
  targetSizeId?: string;
  newSizeName?: string;
  distributeSizeIds?: string[];
};

function normalizeSizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Case-insensitive find-or-create, matching the same duplicate-prevention convention as ensureYieldSizeId (the final-import path) — a name that only differs by case/whitespace reuses the existing size rather than creating a near-duplicate. */
async function findOrCreateYieldSizeByName(organizationId: string, userId: string, rawName: string): Promise<string> {
  const name = rawName.trim();
  if (!name) throw new TemplateValidationError("A size name is required to create a new size.");

  const { data: existingRows, error: existingErr } = await supabase
    .from("yield_sizes")
    .select("id, name")
    .eq("organization_id", organizationId);
  if (existingErr) throw existingErr;

  const match = (existingRows ?? []).find((s) => normalizeSizeName(s.name as string) === normalizeSizeName(name));
  if (match) return match.id as string;

  const { data: created, error: createErr } = await supabase
    .from("yield_sizes")
    .insert({ organization_id: organizationId, name, sort_order: 0, status: "active", created_by: userId })
    .select("id")
    .single();
  if (createErr) throw createErr;
  return created.id as string;
}

async function resolveTargetSizeId(
  organizationId: string,
  userId: string,
  resolution: ResolveLabelInput
): Promise<{ action: "map" | "ignore" | "distribute"; targetSizeId: string | null; distributeSizeIds: string[] | null }> {
  if (resolution.action === "ignore") return { action: "ignore", targetSizeId: null, distributeSizeIds: null };
  if (resolution.action === "distribute") {
    if (!resolution.distributeSizeIds || resolution.distributeSizeIds.length === 0) {
      throw new TemplateValidationError("distributeSizeIds is required for a distribute resolution.");
    }
    await assertYieldSizesBelongToOrg(organizationId, resolution.distributeSizeIds);
    return { action: "distribute", targetSizeId: null, distributeSizeIds: resolution.distributeSizeIds };
  }
  if (resolution.action === "create") {
    const id = await findOrCreateYieldSizeByName(organizationId, userId, resolution.newSizeName ?? resolution.rawValue);
    return { action: "map", targetSizeId: id, distributeSizeIds: null };
  }
  // action === "map"
  if (!resolution.targetSizeId) throw new TemplateValidationError("targetSizeId is required for a map resolution.");
  await assertYieldSizesBelongToOrg(organizationId, [resolution.targetSizeId]);
  return { action: "map", targetSizeId: resolution.targetSizeId, distributeSizeIds: null };
}

/** Never trust a client-supplied yield_sizes id without confirming it belongs to this organization first. */
async function assertYieldSizesBelongToOrg(organizationId: string, sizeIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(sizeIds));
  const { data, error } = await supabase.from("yield_sizes").select("id").eq("organization_id", organizationId).in("id", uniqueIds);
  if (error) throw error;
  if ((data ?? []).length !== uniqueIds.length) {
    throw new TemplateValidationError("One or more selected sizes were not found in this organization.");
  }
}

/** Never trust client-supplied source file ids without confirming each one belongs to this organization first. */
async function assertSourceFilesBelongToOrg(organizationId: string, sourceFileIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(sourceFileIds));
  const { data, error } = await supabase.from("csv_import_source_files").select("id").eq("organization_id", organizationId).in("id", uniqueIds);
  if (error) throw error;
  if ((data ?? []).length !== uniqueIds.length) {
    throw new TemplateValidationError("One or more selected source files were not found in this organization.");
  }
}

export type ResolvePendingLabelsResult = { scope: "pending"; appliedCount: number };

/** "This pending data only" — never versions the matched template. */
export async function resolvePendingLabelsForSources(
  organizationId: string,
  userId: string,
  sourceFileIds: string[],
  resolutions: ResolveLabelInput[]
): Promise<ResolvePendingLabelsResult> {
  if (sourceFileIds.length === 0) throw new TemplateValidationError("At least one affected source file is required.");
  if (resolutions.length === 0) throw new TemplateValidationError("At least one resolution is required.");
  await assertSourceFilesBelongToOrg(organizationId, sourceFileIds);

  let appliedCount = 0;
  for (const resolution of resolutions) {
    if (resolution.action === "unresolved") {
      // "Leave unresolved" is a no-op / removes any prior pending-only override.
      const { error } = await supabase
        .from("csv_source_value_overrides")
        .delete()
        .eq("organization_id", organizationId)
        .in("source_file_id", sourceFileIds)
        .eq("source_field", resolution.sourceField)
        .eq("raw_value", resolution.rawValue);
      if (error) throw error;
      continue;
    }

    const resolved = await resolveTargetSizeId(organizationId, userId, resolution);

    for (const sourceFileId of sourceFileIds) {
      const { error } = await supabase.from("csv_source_value_overrides").upsert(
        {
          organization_id: organizationId,
          source_file_id: sourceFileId,
          source_field: resolution.sourceField,
          raw_value: resolution.rawValue,
          action: resolved.action,
          target_size_id: resolved.targetSizeId,
          distribute_size_ids: resolved.distributeSizeIds,
          created_by: userId,
          updated_at: new Date().toISOString()
        },
        { onConflict: "organization_id,source_file_id,source_field,raw_value" }
      );
      if (error) throw error;
      appliedCount += 1;
    }
  }

  return { scope: "pending", appliedCount };
}

export type ResolveTemplateLabelsResult = {
  scope: "template";
  newTemplateId: string;
  newTemplateVersion: number;
  reprocessedSourceCount: number;
};

/** "Save to template for future imports" — one new version containing every submitted resolution, never a mutation of the current version. */
export async function resolveLabelsForTemplate(
  organizationId: string,
  userId: string,
  templateId: string,
  resolutions: ResolveLabelInput[]
): Promise<ResolveTemplateLabelsResult> {
  if (resolutions.length === 0) throw new TemplateValidationError("At least one resolution is required.");

  const templateRow = await getTemplateById(organizationId, templateId);
  if (!templateRow) throw new TemplateNotFoundError("Template not found.");

  // A source currently matched to this template — required to recompute the
  // fingerprint for the new version (see createTemplateVersion). Any pending
  // source on this exact template has, by definition, this exact layout.
  const { data: representativeRow, error: representativeErr } = await supabase
    .from("agent_pending_imports")
    .select("source_file_id")
    .eq("organization_id", organizationId)
    .eq("csv_mapping_template_id", templateId)
    .eq("data_source_type", "csv_template")
    .not("source_file_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (representativeErr) throw representativeErr;
  if (!representativeRow?.source_file_id) {
    throw new TemplateValidationError("No pending source file is currently matched to this template to base the new version on.");
  }

  const newValueMappings: ValueMapping[] = [...(templateRow.value_mappings ?? [])];
  for (const resolution of resolutions) {
    const key = (m: ValueMapping) => `${m.sourceField}:${normalizeSizeName(m.rawValue)}`;
    const resolutionKey = `${resolution.sourceField}:${normalizeSizeName(resolution.rawValue)}`;
    const existingIndex = newValueMappings.findIndex((m) => key(m) === resolutionKey);

    if (resolution.action === "unresolved") {
      if (existingIndex >= 0) newValueMappings.splice(existingIndex, 1);
      continue;
    }

    const resolved = await resolveTargetSizeId(organizationId, userId, resolution);
    const mapping: ValueMapping = {
      sourceField: resolution.sourceField,
      rawValue: resolution.rawValue,
      action: resolved.action,
      targetSizeId: resolved.targetSizeId ?? undefined,
      distributeSizeIds: resolved.distributeSizeIds ?? undefined
    };
    if (existingIndex >= 0) newValueMappings[existingIndex] = mapping;
    else newValueMappings.push(mapping);
  }

  const versionBody: TemplateWriteInput = {
    name: templateRow.name,
    sourceFileId: representativeRow.source_file_id as string,
    delimiter: templateRow.delimiter,
    headerRowIndex: templateRow.header_row_index,
    dataStartRowIndex: templateRow.data_start_row_index,
    dataEndRowIndex: templateRow.data_end_row_index,
    skipRowIndexes: templateRow.skip_row_indexes ?? [],
    blankRowBehavior: templateRow.blank_row_behavior,
    columnMappings: templateRow.column_mappings ?? [],
    fixedCellMappings: templateRow.fixed_cell_mappings ?? [],
    valueMappings: newValueMappings,
    rules: templateRow.rules ?? []
  };

  const newTemplate = await createTemplateVersion(organizationId, userId, templateId, versionBody);

  // Reprocess every pending source still pointed at the OLD version so it
  // picks up the new resolutions immediately, without re-upload. Safe for
  // every pending row on this template (not just the ones containing the
  // resolved labels) since the new version is a strict superset of mappings.
  const { data: reprocessedRows, error: reprocessError } = await supabase
    .from("agent_pending_imports")
    .update({ csv_mapping_template_id: newTemplate.id })
    .eq("organization_id", organizationId)
    .eq("csv_mapping_template_id", templateId)
    .eq("data_source_type", "csv_template")
    .select("id");
  if (reprocessError) throw reprocessError;

  return {
    scope: "template",
    newTemplateId: newTemplate.id,
    newTemplateVersion: newTemplate.version,
    reprocessedSourceCount: (reprocessedRows ?? []).length
  };
}

// ---------------------------------------------------------------------------
// Grouped ("weekly card") import — server-owned. The client identifies a
// card only by its cardKey (an opaque token from the last GET); every
// figure actually written comes from a FRESH re-parse of each contributing
// source right before writing it, via the exact same importCsvTemplateGroup
// used by the single-file import path (yield_import_runs claim + create/
// append merge + its own duplicate/idempotency guarantees), never from a
// client-supplied total.
// ---------------------------------------------------------------------------

export type ImportWeeklyCardSourceResult = {
  sourceFilename: string;
  lotNumber: string | null;
  status: "imported" | "failed";
  mode?: "create" | "append";
  error?: string;
};

export type ImportWeeklyCardResult = {
  varietyName: string;
  isoYear: number | null;
  isoWeek: number | null;
  totalKgImported: number;
  results: ImportWeeklyCardSourceResult[];
};

export async function importWeeklyCard(organizationId: string, userId: string, cardKey: string): Promise<ImportWeeklyCardResult> {
  const { cards } = await listPendingCsvTemplateWeeklyCards(organizationId);
  const card = cards.find((c) => c.cardKey === cardKey);
  if (!card) {
    throw new TemplateNotFoundError(
      "This weekly card no longer exists — its pending sources may have already been imported or removed. Refresh and try again."
    );
  }
  if (!card.canImport) {
    throw new TemplateValidationError("This card still has unresolved labels or other validation issues and cannot be imported yet.");
  }
  if (card.varietyId === null) {
    throw new TemplateValidationError(`No active variety matches "${card.varietyName}" — resolve the variety before importing.`);
  }

  const results: ImportWeeklyCardSourceResult[] = [];
  let totalKgImported = 0;

  // Sequential, not parallel: each import can append into the SAME
  // yield_entries row for this variety/week, and importCsvTemplateGroup's
  // create-vs-append decision is a read-then-write against that row —
  // running sources in parallel would race two "create" attempts.
  for (const source of card.sources) {
    let freshGroups: NormalizedGroup[];
    try {
      const freshPreview = await buildCsvPreview(organizationId, { sourceFileId: source.sourceFileId, templateId: source.templateId });
      freshGroups = freshPreview.preview.groups.filter(
        (g) =>
          g.isoYear === card.isoYear &&
          g.isoWeek === card.isoWeek &&
          (g.varietyRaw ?? "").trim().toLowerCase() === card.varietyName.trim().toLowerCase()
      );
    } catch (err) {
      results.push({
        sourceFilename: source.sourceFilename,
        lotNumber: source.lotNumber,
        status: "failed",
        error: err instanceof Error ? err.message : "Failed to re-parse this source before import."
      });
      continue;
    }

    if (freshGroups.length === 0) {
      results.push({
        sourceFilename: source.sourceFilename,
        lotNumber: source.lotNumber,
        status: "failed",
        error: "This source no longer contains a matching group for this variety/week (it may have changed since the preview was loaded)."
      });
      continue;
    }

    for (const group of freshGroups) {
      try {
        const importResult = await importCsvTemplateGroup(organizationId, userId, {
          sourceFileId: source.sourceFileId,
          templateId: source.templateId,
          groupKey: group.groupKey,
          approvedGroup: group
        });
        results.push({ sourceFilename: source.sourceFilename, lotNumber: group.lotNumber, status: "imported", mode: importResult.mode });
        totalKgImported += group.reconciliation.recognizedSizeKg;
      } catch (err) {
        results.push({
          sourceFilename: source.sourceFilename,
          lotNumber: group.lotNumber,
          status: "failed",
          error: err instanceof Error ? err.message : "Import failed."
        });
      }
    }
  }

  return {
    varietyName: card.varietyName,
    isoYear: card.isoYear,
    isoWeek: card.isoWeek,
    totalKgImported: Math.round(totalKgImported * 100) / 100,
    results
  };
}

export function parseResolveLabelsBody(input: unknown): {
  scope: "pending" | "template";
  templateId: string;
  sourceFileIds: string[];
  resolutions: ResolveLabelInput[];
} {
  if (!input || typeof input !== "object") throw new TemplateValidationError("Invalid request body");
  const body = input as Record<string, unknown>;

  const scope = body.scope === "template" ? "template" : body.scope === "pending" ? "pending" : null;
  if (!scope) throw new TemplateValidationError('scope must be "pending" or "template"');

  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  if (!templateId) throw new TemplateValidationError("templateId is required");

  const sourceFileIds = Array.isArray(body.sourceFileIds) ? body.sourceFileIds.filter((s): s is string => typeof s === "string") : [];
  if (scope === "pending" && sourceFileIds.length === 0) {
    throw new TemplateValidationError("sourceFileIds is required for a pending-data-only resolution");
  }

  const rawResolutions = Array.isArray(body.resolutions) ? body.resolutions : [];
  const resolutions: ResolveLabelInput[] = rawResolutions.map((raw) => {
    const r = raw as Record<string, unknown>;
    const sourceField = r.sourceField === "market_grade" ? "market_grade" : "size_label";
    const rawValue = typeof r.rawValue === "string" ? r.rawValue : "";
    const action =
      r.action === "map" || r.action === "ignore" || r.action === "distribute" || r.action === "create" || r.action === "unresolved"
        ? r.action
        : null;
    if (!rawValue) throw new TemplateValidationError("Each resolution requires rawValue");
    if (!action) throw new TemplateValidationError("Each resolution requires a valid action");
    return {
      sourceField,
      rawValue,
      action,
      targetSizeId: typeof r.targetSizeId === "string" ? r.targetSizeId : undefined,
      newSizeName: typeof r.newSizeName === "string" ? r.newSizeName : undefined,
      distributeSizeIds: Array.isArray(r.distributeSizeIds) ? r.distributeSizeIds.filter((s): s is string => typeof s === "string") : undefined
    };
  });
  if (resolutions.length === 0) throw new TemplateValidationError("At least one resolution is required");

  return { scope, templateId, sourceFileIds, resolutions };
}

// ---------------------------------------------------------------------------
// Routes — thin wrappers translating the functions above to HTTP.
// ---------------------------------------------------------------------------

function handleKnownError(res: import("express").Response, error: unknown, fallbackMessage: string, logContext: string): unknown {
  if (error instanceof TemplateValidationError) return res.status(400).json({ message: error.message });
  if (error instanceof TemplateNotFoundError) return res.status(404).json({ message: error.message });
  if (error instanceof TemplateNotCurrentError) return res.status(400).json({ message: error.message });
  if (error instanceof TemplateConflictError) return res.status(409).json({ message: error.message });
  if (error instanceof TemplateInUseError) return res.status(409).json({ message: error.message });
  return sendSafeError(res, 500, fallbackMessage, logContext, error);
}

function requireUserId(req: import("express").Request, res: import("express").Response): string | null {
  if (!req.userId) {
    res.status(401).json({ message: "Authentication required." });
    return null;
  }
  return req.userId;
}

csvMappingTemplatesRouter.post("/csv-templates/parse-grid", canView, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No CSV file was uploaded." });
  }
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const result = await parseAndMatchCsvFile(req.organizationId, userId, req.file);
    return res.json(result);
  } catch (error) {
    return handleKnownError(res, error, "Failed to parse the uploaded CSV file.", "csv-templates parse-grid error:");
  }
});

csvMappingTemplatesRouter.get("/csv-templates", canView, async (req, res) => {
  try {
    const rows = await listTemplatesForOrg(req.organizationId);
    const names = await resolveUserDisplayNames(rows.flatMap((r) => [r.created_by, r.updated_by]));
    return res.json(
      rows.map((row) => ({
        ...templateRowToSummary(row),
        createdByName: names.get(row.created_by) ?? "Unknown",
        updatedByName: names.get(row.updated_by) ?? "Unknown"
      }))
    );
  } catch (error) {
    return handleKnownError(res, error, "Failed to load CSV templates.", "csv-templates list error:");
  }
});

// Must be registered before GET /csv-templates/:id — otherwise Express
// matches "pending" as the :id param (a single path segment satisfies :id)
// and getTemplateById("pending") fails with a Postgres invalid-uuid error,
// surfacing as the detail route's generic 500 instead of the pending list.
csvMappingTemplatesRouter.get("/csv-templates/pending", canView, async (req, res) => {
  try {
    const items = await listPendingCsvTemplateImports(req.organizationId);
    return res.json({ files: items });
  } catch (error) {
    return handleKnownError(res, error, "Failed to load pending CSV imports.", "csv-templates pending list error:");
  }
});

csvMappingTemplatesRouter.get("/csv-templates/pending/weekly-cards", canView, async (req, res) => {
  try {
    const result = await listPendingCsvTemplateWeeklyCards(req.organizationId);
    return res.json(result);
  } catch (error) {
    return handleKnownError(res, error, "Failed to load pending CSV imports.", "csv-templates weekly-cards list error:");
  }
});

csvMappingTemplatesRouter.post("/csv-templates/pending/resolve-labels", canEdit, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const body = parseResolveLabelsBody(req.body);
    if (body.scope === "pending") {
      const result = await resolvePendingLabelsForSources(req.organizationId, userId, body.sourceFileIds, body.resolutions);
      return res.status(201).json(result);
    }
    const result = await resolveLabelsForTemplate(req.organizationId, userId, body.templateId, body.resolutions);
    return res.status(201).json(result);
  } catch (error) {
    return handleKnownError(res, error, "Failed to resolve label(s).", "csv-templates resolve-labels error:");
  }
});

csvMappingTemplatesRouter.post("/csv-templates/pending/import-week", canEdit, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const cardKey = typeof req.body?.cardKey === "string" ? req.body.cardKey : "";
    if (!cardKey) return res.status(400).json({ message: "cardKey is required." });
    const result = await importWeeklyCard(req.organizationId, userId, cardKey);
    return res.status(201).json(result);
  } catch (error) {
    return handleKnownError(res, error, "Failed to import this weekly card.", "csv-templates import-week error:");
  }
});

csvMappingTemplatesRouter.get("/csv-templates/:id", canView, async (req, res) => {
  try {
    const row = await getTemplateById(req.organizationId, String(req.params.id));
    if (!row) return res.status(404).json({ message: "Template not found." });
    const names = await resolveUserDisplayNames([row.created_by, row.updated_by]);
    return res.json({
      ...templateRowToDetail(row),
      createdByName: names.get(row.created_by) ?? "Unknown",
      updatedByName: names.get(row.updated_by) ?? "Unknown"
    });
  } catch (error) {
    return handleKnownError(res, error, "Failed to load the CSV template.", "csv-templates detail error:");
  }
});

csvMappingTemplatesRouter.post("/csv-templates", canEdit, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const body = parseTemplateWriteBody(req.body);
    const row = await createTemplate(req.organizationId, userId, body);
    return res.status(201).json(templateRowToDetail(row));
  } catch (error) {
    return handleKnownError(res, error, "Failed to create CSV template.", "csv-templates create error:");
  }
});

csvMappingTemplatesRouter.put("/csv-templates/:id", canEdit, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const body = parseTemplateWriteBody(req.body);
    const row = await createTemplateVersion(req.organizationId, userId, String(req.params.id), body);
    return res.json(templateRowToDetail(row));
  } catch (error) {
    return handleKnownError(res, error, "Failed to save a new template version.", "csv-templates version error:");
  }
});

csvMappingTemplatesRouter.patch("/csv-templates/:id/rename", canEdit, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const row = await renameTemplate(req.organizationId, userId, String(req.params.id), name);
    return res.json(templateRowToSummary(row));
  } catch (error) {
    return handleKnownError(res, error, "Failed to rename template.", "csv-templates rename error:");
  }
});

csvMappingTemplatesRouter.patch("/csv-templates/:id/active", canEdit, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const isActive = req.body?.isActive === true;
    const row = await setTemplateActive(req.organizationId, userId, String(req.params.id), isActive);
    return res.json(templateRowToSummary(row));
  } catch (error) {
    return handleKnownError(res, error, "Failed to update template status.", "csv-templates active toggle error:");
  }
});

csvMappingTemplatesRouter.post("/csv-templates/:id/duplicate", canEdit, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : null;
    const row = await duplicateTemplate(req.organizationId, userId, String(req.params.id), name);
    return res.status(201).json(templateRowToDetail(row));
  } catch (error) {
    return handleKnownError(res, error, "Failed to duplicate template.", "csv-templates duplicate error:");
  }
});

csvMappingTemplatesRouter.delete("/csv-templates/:id", canEdit, async (req, res) => {
  try {
    await deleteTemplateIfUnused(req.organizationId, String(req.params.id));
    return res.status(204).send();
  } catch (error) {
    return handleKnownError(res, error, "Failed to delete template.", "csv-templates delete error:");
  }
});

csvMappingTemplatesRouter.post("/csv-templates/preview", canView, async (req, res) => {
  try {
    const body = parsePreviewBody(req.body);
    const result = await buildCsvPreview(req.organizationId, body);
    return res.json(result);
  } catch (error) {
    return handleKnownError(res, error, "Failed to build CSV preview.", "csv-templates preview error:");
  }
});

// Lets the Template Builder UI resume an already-uploaded source file (e.g.
// from a pending review row's "Set up CSV template" action) without
// requiring the raw bytes to be uploaded again.
csvMappingTemplatesRouter.get("/csv-templates/source-files/:id/grid", canView, async (req, res) => {
  try {
    const result = await getSourceFileGridAndMatch(req.organizationId, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return handleKnownError(res, error, "Failed to load source file.", "csv-templates source-file grid error:");
  }
});

csvMappingTemplatesRouter.post("/csv-templates/pending", canEdit, async (req, res) => {
  try {
    const sourceFileId = typeof req.body?.sourceFileId === "string" ? req.body.sourceFileId : "";
    const sourceFilename = typeof req.body?.sourceFilename === "string" ? req.body.sourceFilename : "";
    const templateId = typeof req.body?.templateId === "string" ? req.body.templateId : null;
    const needsTemplate = req.body?.needsTemplate === true || !templateId;

    if (!sourceFileId || !sourceFilename) {
      return res.status(400).json({ message: "sourceFileId and sourceFilename are required." });
    }

    const row = await createPendingCsvTemplateImport(req.organizationId, sourceFileId, sourceFilename, templateId, needsTemplate);
    return res.status(201).json(row);
  } catch (error) {
    return handleKnownError(res, error, "Failed to stage CSV file for review.", "csv-templates pending create error:");
  }
});

csvMappingTemplatesRouter.post("/csv-templates/import", canEdit, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const body = parseImportBody(req.body);
    const result = await importCsvTemplateGroup(req.organizationId, userId, body);
    return res.status(201).json(result);
  } catch (error) {
    return handleKnownError(res, error, "Failed to import CSV data.", "csv-templates import error:");
  }
});

export { csvMappingTemplatesRouter };
