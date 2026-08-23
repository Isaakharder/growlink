import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import { parseCsvGridFromBuffer, parseCsvGrid } from "../utils/csvGridParser";
import { computeFingerprint, computeFingerprintHash, matchFingerprint, type FingerprintCandidate } from "../utils/csvTemplateFingerprint";
import { normalizeCsvWithTemplate, type EngineContext } from "../utils/csvTemplateEngine";
import type {
  BlankRowBehavior,
  ColumnMapping,
  ConditionalRowRule,
  FixedCellMapping,
  NormalizedPreview,
  TemplateConfig,
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
  return {
    id: row.id,
    templateGroupId: row.template_group_id,
    name: row.name,
    version: row.version,
    isActive: row.is_active,
    delimiter: row.delimiter,
    headerRowIndex: row.header_row_index,
    columnCount: Array.isArray(headers) ? headers.length : null,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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
  match: {
    kind: "exact" | "close" | "none";
    templateId: string | null;
    templateName: string | null;
    similarity: number | null;
  };
};

export async function parseAndMatchCsvFile(
  organizationId: string,
  userId: string,
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

export async function createTemplate(organizationId: string, userId: string, body: TemplateWriteInput): Promise<TemplateRow> {
  const { fingerprint, fingerprintHash } = await computeFingerprintForSourceFile(
    organizationId,
    body.sourceFileId,
    body.delimiter,
    body.headerRowIndex
  );

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

  const { error: demoteErr } = await supabase.from("csv_mapping_templates").update({ is_current: false }).eq("id", templateId);
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
    await supabase.from("csv_mapping_templates").update({ is_current: true }).eq("id", templateId);
    if (insertErr.code === "23505") {
      throw new TemplateConflictError("An active template already exists for this exact CSV layout.");
    }
    throw insertErr;
  }

  return inserted as TemplateRow;
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

export type PreviewResult = {
  preview: NormalizedPreview;
  templateId: string | null;
  templateVersion: number | null;
  layoutMismatch: boolean;
};

export async function buildCsvPreview(organizationId: string, body: PreviewInput): Promise<PreviewResult> {
  let config: TemplateConfig;
  let layoutMismatch = false;
  let templateRow: TemplateRow | null = null;

  if (body.templateId) {
    templateRow = await getTemplateById(organizationId, body.templateId);
    if (!templateRow) throw new TemplateNotFoundError("Template not found.");

    config = templateRowToConfig(templateRow);

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

  const finalPreview: NormalizedPreview = layoutMismatch
    ? {
        ...preview,
        validationIssues: [
          { code: "layout_mismatch", message: "The uploaded file's structure no longer matches this template. Please review before importing." },
          ...preview.validationIssues
        ],
        canImport: false
      }
    : preview;

  return {
    preview: finalPreview,
    templateId: templateRow?.id ?? null,
    templateVersion: templateRow?.version ?? null,
    layoutMismatch
  };
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
    return res.json(rows.map(templateRowToSummary));
  } catch (error) {
    return handleKnownError(res, error, "Failed to load CSV templates.", "csv-templates list error:");
  }
});

csvMappingTemplatesRouter.get("/csv-templates/:id", canView, async (req, res) => {
  try {
    const row = await getTemplateById(req.organizationId, String(req.params.id));
    if (!row) return res.status(404).json({ message: "Template not found." });
    return res.json(templateRowToDetail(row));
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

export { csvMappingTemplatesRouter };
