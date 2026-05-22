import { Request, Router } from "express";
import multer from "multer";
import { supabase } from "../config/supabase";
import { parseFlowMasterPdfBuffer } from "../utils/flowMasterPdfParser";

const pdfImportRouter = Router();

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_REQUEST
  },
  fileFilter(_req, file, cb) {
    const isPdfMime = file.mimetype === "application/pdf";
    const isPdfExt = /\.pdf$/i.test(file.originalname);

    if (isPdfMime || isPdfExt) {
      cb(null, true);
      return;
    }

    cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
  }
});

type PdfPreviewSuccess = {
  filename: string;
  success: true;
  lotNumber: string | null;
  alreadyImported: boolean;
  skipped: boolean;
  variety: string | null;
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
};

type PdfPreviewFailure = {
  filename: string;
  success: false;
  error: {
    message: string;
  };
};

type PdfPreviewItem = PdfPreviewSuccess | PdfPreviewFailure;

type PdfImportMode = "create" | "append";

type PdfImportPayload = {
  mode: PdfImportMode;
  varietyId: string;
  isoYear: number;
  isoWeek: number;
  sizeBreakdown: Record<string, number>;
  averageFruitWeightG: number | null;
  sourceRuns: Array<{
    lotNumber: string;
    startTime: string | null;
    sourceFilename: string | null;
  }>;
};

type ActiveVariety = {
  id: string;
  name: string;
};

type ActiveYieldSize = {
  name: string;
};

type ExistingYieldEntry = {
  variety_id: string;
  year: number;
  week: number;
};

type ExistingImportRun = {
  lot_number: string;
};

export type ActiveYieldSizeWithId = {
  id: string;
  name: string;
};

export type VarietyForCalc = {
  id: string;
  area_m2: number;
  case_kg: number;
};

const KNOWN_SIZE_LABEL_MAP: Record<string, string> = {
  SM: "Small",
  MD: "Medium",
  LG: "Large",
  SXL: "SXL",
  XL: "XL",
  XXL: "XXL"
};

const KNOWN_SIZE_TARGET_TO_LABEL = Object.entries(KNOWN_SIZE_LABEL_MAP).reduce<Record<string, string>>(
  (acc, [label, target]) => {
    acc[target] = label;
    return acc;
  },
  {}
);

export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

// Stripped + lowercased aliases → canonical matching key.
// Handles short codes (SM/MD/LG) and full names interchangeably.
const SIZE_ALIAS_MAP: Record<string, string> = {
  sm: "sm",
  small: "sm",
  md: "md",
  med: "md",
  medium: "md",
  lg: "lg",
  large: "lg",
  xl: "xl",
  extralarge: "xl",
  xlarge: "xl",
  sxl: "sxl",
  superxl: "sxl",
  xxl: "xxl",
  doublexl: "xxl",
  "24ct": "24ct",
  "24count": "24ct"
};

export function canonicalizeSizeName(value: string): string {
  const stripped = value.trim().toLowerCase().replace(/[\s\-_]/g, "");
  return SIZE_ALIAS_MAP[stripped] ?? stripped;
}

export type SizeMappingResult = {
  mapped: Record<string, number>;
  matched: Array<{ pdfLabel: string; canonicalLabel: string; sizeId: string; sizeName: string }>;
  skipped: Array<{ pdfLabel: string; canonicalLabel: string }>;
};

export function parseFlowMasterStartTimeToIso(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(" ", "T") + ":00Z";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString();
}

export function calculateTotals(sizeKg: Record<string, number>, variety: VarietyForCalc) {
  const total_kg = Object.values(sizeKg).reduce((sum, value) => sum + value, 0);
  const kg_per_m2 = variety.area_m2 > 0 ? total_kg / variety.area_m2 : 0;
  const total_cases = variety.case_kg > 0 ? total_kg / variety.case_kg : 0;

  return { total_kg, kg_per_m2, total_cases };
}

function parsePdfImportPayload(input: unknown): PdfImportPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request body.");
  }

  const body = input as Record<string, unknown>;

  if (body.mode !== "create" && body.mode !== "append") {
    throw new Error("mode must be \"create\" or \"append\".");
  }

  const varietyId = typeof body.varietyId === "string" ? body.varietyId.trim() : "";
  if (!varietyId) {
    throw new Error("varietyId is required.");
  }

  const isoYear = typeof body.isoYear === "number" ? body.isoYear : Number(body.isoYear);
  const isoWeek = typeof body.isoWeek === "number" ? body.isoWeek : Number(body.isoWeek);

  if (!Number.isInteger(isoYear)) {
    throw new Error("isoYear is required.");
  }

  if (!Number.isInteger(isoWeek) || isoWeek < 1 || isoWeek > 53) {
    throw new Error("isoWeek must be between 1 and 53.");
  }

  const rawBreakdown = body.sizeBreakdown;
  if (!rawBreakdown || typeof rawBreakdown !== "object" || Array.isArray(rawBreakdown)) {
    throw new Error("sizeBreakdown must be an object of size name to kg.");
  }

  const sizeBreakdown: Record<string, number> = {};
  for (const [sizeName, rawKg] of Object.entries(rawBreakdown as Record<string, unknown>)) {
    const normalizedSize = sizeName.trim();
    const kg = typeof rawKg === "number" ? rawKg : Number(rawKg);

    if (!normalizedSize) {
      throw new Error("sizeBreakdown contains an empty size name.");
    }

    if (!Number.isFinite(kg) || kg < 0) {
      throw new Error(`Invalid kg value for size ${normalizedSize}.`);
    }

    sizeBreakdown[normalizedSize] = kg;
  }

  const averageRaw = body.averageFruitWeightG;
  const averageFruitWeightG =
    averageRaw === null || averageRaw === undefined || averageRaw === ""
      ? null
      : (typeof averageRaw === "number" ? averageRaw : Number(averageRaw));

  if (
    averageFruitWeightG !== null &&
    (!Number.isFinite(averageFruitWeightG) || averageFruitWeightG < 0)
  ) {
    throw new Error("averageFruitWeightG must be null or a non-negative number.");
  }

  const rawSourceRuns = body.sourceRuns;
  if (!Array.isArray(rawSourceRuns) || rawSourceRuns.length === 0) {
    throw new Error("sourceRuns must include at least one lot number.");
  }

  const sourceRuns: PdfImportPayload["sourceRuns"] = [];
  const seenLots = new Set<string>();

  for (const raw of rawSourceRuns) {
    if (!raw || typeof raw !== "object") {
      throw new Error("sourceRuns contains an invalid row.");
    }

    const row = raw as Record<string, unknown>;
    const lotNumber = typeof row.lotNumber === "string" ? row.lotNumber.trim() : "";
    if (!lotNumber) {
      throw new Error("Each source run requires a lotNumber.");
    }

    if (seenLots.has(lotNumber)) {
      continue;
    }
    seenLots.add(lotNumber);

    sourceRuns.push({
      lotNumber,
      startTime: typeof row.startTime === "string" ? row.startTime : null,
      sourceFilename: typeof row.sourceFilename === "string" ? row.sourceFilename : null
    });
  }

  if (sourceRuns.length === 0) {
    throw new Error("No unique lot numbers were provided for import.");
  }

  return {
    mode: body.mode,
    varietyId,
    isoYear,
    isoWeek,
    sizeBreakdown,
    averageFruitWeightG,
    sourceRuns
  };
}

export function mapSizeNamesToIds(
  sizeBreakdown: Record<string, number>,
  activeSizes: ActiveYieldSizeWithId[]
): SizeMappingResult {
  const byCanonical = new Map<string, ActiveYieldSizeWithId>();
  for (const size of activeSizes) {
    byCanonical.set(canonicalizeSizeName(size.name), size);
  }

  const mapped: Record<string, number> = {};
  const matched: SizeMappingResult["matched"] = [];
  const skipped: SizeMappingResult["skipped"] = [];

  for (const [sizeName, kg] of Object.entries(sizeBreakdown)) {
    const canonical = canonicalizeSizeName(sizeName);
    const matchedSize = byCanonical.get(canonical);
    if (matchedSize) {
      mapped[matchedSize.id] = kg;
      matched.push({ pdfLabel: sizeName, canonicalLabel: canonical, sizeId: matchedSize.id, sizeName: matchedSize.name });
    } else {
      skipped.push({ pdfLabel: sizeName, canonicalLabel: canonical });
    }
  }

  return { mapped, matched, skipped };
}

function parseUploadedFiles(req: Request): Express.Multer.File[] {
  const maybeFiles = req.files;
  if (!Array.isArray(maybeFiles)) {
    return [];
  }
  return maybeFiles as Express.Multer.File[];
}

pdfImportRouter.post("/pdf-import/preview", (req, res) => {
  upload.array("files", MAX_FILES_PER_REQUEST)(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError) {
        if (uploadError.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            message: "Each PDF must be 15MB or smaller."
          });
        }

        if (uploadError.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({
            message: `You can upload up to ${MAX_FILES_PER_REQUEST} PDFs at once.`
          });
        }

        return res.status(400).json({
          message: "Only PDF files are allowed."
        });
      }

      console.error("PDF preview upload middleware error:", uploadError);
      return res.status(500).json({
        message: "Failed to process upload."
      });
    }

    const uploadedFiles = parseUploadedFiles(req);

    if (uploadedFiles.length === 0) {
      return res.status(400).json({
        message: "Please upload at least one PDF file."
      });
    }

    const organizationId = req.organizationId;

    const [varietiesResult, yieldSizesResult, yieldEntriesResult] = await Promise.all([
      supabase
        .from("varieties")
        .select("id, name")
        .eq("organization_id", organizationId)
        .eq("status", "active"),
      supabase
        .from("yield_sizes")
        .select("name")
        .eq("organization_id", organizationId)
        .eq("status", "active"),
      supabase
        .from("yield_entries")
        .select("variety_id, year, week")
        .eq("organization_id", organizationId)
    ]);

    if (varietiesResult.error) {
      return res.status(500).json({
        message: "Failed to load active varieties for PDF preview."
      });
    }

    if (yieldSizesResult.error) {
      return res.status(500).json({
        message: "Failed to load active yield sizes for PDF preview."
      });
    }

    if (yieldEntriesResult.error) {
      return res.status(500).json({
        message: "Failed to load existing yield entries for duplicate checks."
      });
    }

    const activeVarieties = (varietiesResult.data ?? []) as ActiveVariety[];
    const activeYieldSizes = (yieldSizesResult.data ?? []) as ActiveYieldSize[];
    const existingYieldEntries = (yieldEntriesResult.data ?? []) as ExistingYieldEntry[];

    const activeVarietyByExactName = new Map<string, ActiveVariety>();
    for (const variety of activeVarieties) {
      activeVarietyByExactName.set(variety.name, variety);
    }

    const activeYieldSizeNameByCanonical = new Map<string, string>();
    for (const size of activeYieldSizes) {
      activeYieldSizeNameByCanonical.set(canonicalizeSizeName(size.name), size.name);
    }

    const existingEntryKeySet = new Set<string>();
    for (const entry of existingYieldEntries) {
      existingEntryKeySet.add(`${entry.variety_id}::${entry.year}::${entry.week}`);
    }

    const parsedFiles = await Promise.all(
      uploadedFiles.map(async (file) => {
        try {
          const parsed = await parseFlowMasterPdfBuffer(file.buffer, file.originalname);
          return {
            filename: file.originalname,
            parsed,
            parseError: null as null
          };
        } catch (error) {
          return {
            filename: file.originalname,
            parsed: null,
            parseError: error instanceof Error ? error.message : "Failed to parse PDF."
          };
        }
      })
    );

    const uploadedLots = Array.from(
      new Set(
        parsedFiles
          .map((row) => row.parsed?.lotNumber)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
      )
    );

    const alreadyImportedLots = new Set<string>();

    if (uploadedLots.length > 0) {
      const { data: importRuns, error: importRunsError } = await supabase
        .from("yield_import_runs")
        .select("lot_number")
        .eq("organization_id", organizationId)
        .in("lot_number", uploadedLots);

      if (importRunsError) {
        console.error("PDF preview import history lookup failed:", {
          organizationId,
          uploadedLotsCount: uploadedLots.length,
          code: importRunsError.code,
          message: importRunsError.message,
          details: importRunsError.details,
          hint: importRunsError.hint
        });
        return res.status(500).json({
          message: "Failed to load imported lot history for duplicate checks."
        });
      }

      for (const run of (importRuns ?? []) as ExistingImportRun[]) {
        alreadyImportedLots.add(run.lot_number);
      }
    }

    const seenLotsInBatch = new Set<string>();

    const files: PdfPreviewItem[] = await Promise.all(
      parsedFiles.map(async (file): Promise<PdfPreviewItem> => {
        try {
          if (!file.parsed) {
            throw new Error(file.parseError ?? "Failed to parse PDF.");
          }

          const parsed = file.parsed;

          const warnings = [...parsed.warnings];

          let skipped = false;
          let alreadyImported = false;

          if (parsed.lotNumber && alreadyImportedLots.has(parsed.lotNumber)) {
            skipped = true;
            alreadyImported = true;
            warnings.push(`Lot ${parsed.lotNumber} was already imported and will be skipped.`);
          } else if (parsed.lotNumber) {
            if (seenLotsInBatch.has(parsed.lotNumber)) {
              skipped = true;
              warnings.push(
                `Duplicate file/run detected for Lot ${parsed.lotNumber}. It was only counted once.`
              );
            } else {
              seenLotsInBatch.add(parsed.lotNumber);
            }
          }

          const matchedVariety =
            parsed.varietyName !== null
              ? activeVarietyByExactName.get(parsed.varietyName) ?? null
              : null;

          if (parsed.varietyName && !matchedVariety) {
            warnings.push(
              `Variety not found: ${parsed.varietyName}. Add or rename variety before importing.`
            );
          }

          const unknownSizeSet = new Set<string>(parsed.unknownSizes);
          const mapped: Array<{ pdfSize: string; growlinkSize: string }> = [];

          for (const parsedSizeName of Object.keys(parsed.sizeKg)) {
            const canonical = canonicalizeSizeName(parsedSizeName);
            const activeSizeName = activeYieldSizeNameByCanonical.get(canonical);
            const pdfSizeLabel =
              KNOWN_SIZE_TARGET_TO_LABEL[parsedSizeName] ?? parsedSizeName;

            if (activeSizeName) {
              mapped.push({
                pdfSize: pdfSizeLabel,
                growlinkSize: activeSizeName
              });
            } else {
              unknownSizeSet.add(pdfSizeLabel);
              warnings.push(
                `New size found: ${pdfSizeLabel}. Add this size in GrowLink before importing.`
              );
            }
          }

          const unknownSizes = Array.from(unknownSizeSet);

          const duplicateKey =
            matchedVariety && parsed.isoYear !== null && parsed.isoWeek !== null
              ? `${matchedVariety.id}::${parsed.isoYear}::${parsed.isoWeek}`
              : null;

          const hasExistingWeeklyData =
            duplicateKey !== null && existingEntryKeySet.has(duplicateKey);

          // TODO: Replace this coarse weekly-data signal with true duplicate-run
          // detection backed by import history (filename, start time, variety_id,
          // isoYear, isoWeek, optional PDF hash).
          if (hasExistingWeeklyData && matchedVariety) {
            warnings.push(
              `Existing weekly data found. Import will add these PDF totals to the week.`
            );
          }

          const uniqueWarnings = Array.from(new Set(warnings));

          return {
            filename: file.filename,
            success: true,
            lotNumber: parsed.lotNumber,
            alreadyImported,
            skipped,
            variety: parsed.varietyName,
            matchedVariety: {
              found: Boolean(matchedVariety),
              varietyId: matchedVariety?.id ?? null,
              varietyName: matchedVariety?.name ?? null
            },
            startTime: parsed.startTime,
            startDate: parsed.startDate,
            isoWeek: parsed.isoWeek,
            isoYear: parsed.isoYear,
            totalKg: parsed.totalKg,
            averageFruitWeightG: parsed.averageFruitWeightG,
            sizeBreakdown: parsed.sizeKg,
            sizeMappingStatus: {
              mappedCount: mapped.length,
              unmappedCount: unknownSizes.length,
              mapped,
              unmapped: unknownSizes
            },
            duplicateStatus: {
              found: hasExistingWeeklyData
            },
            unknownSizes,
            warnings: uniqueWarnings
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to parse PDF.";

          console.error("PDF preview parse error:", {
            file: file.filename,
            message,
            error
          });

          return {
            filename: file.filename,
            success: false,
            error: {
              message
            }
          };
        }
      })
    );

    return res.json({
      success: true,
      files
    });
  });
});

export { pdfImportRouter };

pdfImportRouter.post("/pdf-import/import", async (req, res) => {
  let payload: PdfImportPayload;

  try {
    payload = parsePdfImportPayload(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body.";
    return res.status(400).json({ message });
  }

  const organizationId = req.organizationId;

  const [varietyResult, activeSizesResult, existingEntriesResult] = await Promise.all([
    supabase
      .from("varieties")
      .select("id, area_m2, case_kg")
      .eq("organization_id", organizationId)
      .eq("id", payload.varietyId)
      .single(),
    supabase
      .from("yield_sizes")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("status", "active"),
    supabase
      .from("yield_entries")
      .select("id, size_kg, average_fruit_weight_g")
      .eq("organization_id", organizationId)
      .eq("variety_id", payload.varietyId)
      .eq("year", payload.isoYear)
      .eq("week", payload.isoWeek)
  ]);

  if (varietyResult.error || !varietyResult.data) {
    return res.status(400).json({
      message: "Matched variety was not found for this organization."
    });
  }

  if (activeSizesResult.error) {
    return res.status(500).json({
      message: "Failed to load active sizes for import."
    });
  }

  if (existingEntriesResult.error) {
    return res.status(500).json({
      message: "Failed to check existing entries before import."
    });
  }

  const existingEntryCount = (existingEntriesResult.data ?? []).length;

  const lotNumbers = payload.sourceRuns.map((run) => run.lotNumber);
  const { data: existingImportRuns, error: importRunsLookupError } = await supabase
    .from("yield_import_runs")
    .select("lot_number")
    .eq("organization_id", organizationId)
    .in("lot_number", lotNumbers);

  if (importRunsLookupError) {
    console.error("PDF import lot history precheck failed:", {
      organizationId,
      lotCount: lotNumbers.length,
      code: importRunsLookupError.code,
      message: importRunsLookupError.message,
      details: importRunsLookupError.details,
      hint: importRunsLookupError.hint
    });
    return res.status(500).json({
      message: "Failed to validate lot import history before import."
    });
  }

  const alreadyImportedLots = new Set(
    ((existingImportRuns ?? []) as ExistingImportRun[]).map((run) => run.lot_number)
  );

  if (alreadyImportedLots.size > 0) {
    return res.status(409).json({
      message: "One or more lots were already imported."
    });
  }

  if (payload.mode === "create" && existingEntryCount > 0) {
    return res.status(409).json({
      message: "A weekly entry already exists for this variety and week. Use append mode."
    });
  }

  if (payload.mode === "append" && existingEntryCount > 1) {
    return res.status(409).json({
      message: "Multiple weekly entries exist for this variety/week. Resolve duplicates before appending PDF data."
    });
  }

  const activeSizes = (activeSizesResult.data ?? []) as ActiveYieldSizeWithId[];
  const sizeMappingResult = mapSizeNamesToIds(payload.sizeBreakdown, activeSizes);

  if (sizeMappingResult.skipped.length > 0) {
    const unknownNames = sizeMappingResult.skipped.map((s) => s.pdfLabel).join(", ");
    return res.status(400).json({
      message: `Unknown size(s): ${unknownNames}. Add these active sizes before importing.`
    });
  }

  const sizeKgById = sizeMappingResult.mapped;
  const totals = calculateTotals(sizeKgById, varietyResult.data as VarietyForCalc);

  if (payload.mode === "append" && existingEntryCount === 1) {
    const existingEntry = (existingEntriesResult.data ?? [])[0] as {
      id: string;
      size_kg: Record<string, unknown> | null;
      average_fruit_weight_g: number | null;
    };

    // Claim the lots first — the unique constraint on (organization_id, lot_number)
    // prevents a concurrent import of the same lots from racing past this point.
    const importRunRows = payload.sourceRuns.map((run) => ({
      organization_id: organizationId,
      lot_number: run.lotNumber,
      variety_id: payload.varietyId,
      iso_year: payload.isoYear,
      iso_week: payload.isoWeek,
      start_time: parseFlowMasterStartTimeToIso(run.startTime),
      source_filename: run.sourceFilename,
      created_by: req.userId
    }));

    const { error: claimError } = await supabase
      .from("yield_import_runs")
      .insert(importRunRows);

    if (claimError) {
      if (claimError.code === "23505") {
        return res.status(409).json({
          message: "One or more lots were already imported."
        });
      }
      console.error("PDF import history insert failed (append mode):", {
        organizationId,
        lotCount: payload.sourceRuns.length,
        code: claimError.code,
        message: claimError.message,
        details: claimError.details,
        hint: claimError.hint
      });
      return res.status(500).json({
        message: "Failed to record import history."
      });
    }

    const existingSizeKgRaw = existingEntry.size_kg ?? {};
    const existingSizeKg: Record<string, number> = {};

    for (const [sizeId, rawKg] of Object.entries(existingSizeKgRaw)) {
      const kg = typeof rawKg === "number" ? rawKg : Number(rawKg);
      if (Number.isFinite(kg) && kg >= 0) {
        existingSizeKg[sizeId] = kg;
      }
    }

    const mergedSizeKg: Record<string, number> = { ...existingSizeKg };
    for (const [sizeId, incomingKg] of Object.entries(sizeKgById)) {
      mergedSizeKg[sizeId] = (mergedSizeKg[sizeId] ?? 0) + incomingKg;
    }

    const existingTotalKg = Object.values(existingSizeKg).reduce((sum, kg) => sum + kg, 0);
    const incomingTotalKg = Object.values(sizeKgById).reduce((sum, kg) => sum + kg, 0);
    const mergedWeightedDenominator =
      (existingEntry.average_fruit_weight_g !== null ? existingTotalKg : 0) +
      (payload.averageFruitWeightG !== null ? incomingTotalKg : 0);

    const mergedAverageFruitWeightG =
      mergedWeightedDenominator > 0
        ? ((existingEntry.average_fruit_weight_g !== null
            ? existingEntry.average_fruit_weight_g * existingTotalKg
            : 0) +
            (payload.averageFruitWeightG !== null
              ? payload.averageFruitWeightG * incomingTotalKg
              : 0)) /
          mergedWeightedDenominator
        : null;

    const mergedTotals = calculateTotals(mergedSizeKg, varietyResult.data as VarietyForCalc);

    const { data: updated, error: updateError } = await supabase
      .from("yield_entries")
      .update({
        size_kg: mergedSizeKg,
        average_fruit_weight_g: mergedAverageFruitWeightG,
        ...mergedTotals,
        updated_at: new Date().toISOString()
      })
      .eq("id", existingEntry.id)
      .eq("organization_id", organizationId)
      .select("id, variety_id, year, week, total_kg")
      .single();

    if (updateError || !updated) {
      // Release the claims so the lots can be retried.
      const lotNumbers = importRunRows.map((r) => r.lot_number);
      const { error: releaseError } = await supabase
        .from("yield_import_runs")
        .delete()
        .eq("organization_id", organizationId)
        .in("lot_number", lotNumbers);
      if (releaseError) {
        console.error("PDF import history release failed (append mode):", {
          organizationId,
          lotNumbers,
          code: releaseError.code,
          message: releaseError.message
        });
      }
      return res.status(500).json({
        message: "Failed to append PDF preview data into weekly entry."
      });
    }

    return res.status(200).json({
      success: true,
      mode: "append",
      entry: updated
    });
  }

  // Claim the lots first — the unique constraint on (organization_id, lot_number)
  // prevents a concurrent import of the same lots from racing past this point.
  const createImportRunRows = payload.sourceRuns.map((run) => ({
    organization_id: organizationId,
    lot_number: run.lotNumber,
    variety_id: payload.varietyId,
    iso_year: payload.isoYear,
    iso_week: payload.isoWeek,
    start_time: parseFlowMasterStartTimeToIso(run.startTime),
    source_filename: run.sourceFilename,
    created_by: req.userId
  }));

  const { error: claimError } = await supabase
    .from("yield_import_runs")
    .insert(createImportRunRows);

  if (claimError) {
    if (claimError.code === "23505") {
      return res.status(409).json({
        message: "One or more lots were already imported."
      });
    }
    console.error("PDF import history insert failed (create mode):", {
      organizationId,
      lotCount: payload.sourceRuns.length,
      code: claimError.code,
      message: claimError.message,
      details: claimError.details,
      hint: claimError.hint
    });
    return res.status(500).json({
      message: "Failed to record import history."
    });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("yield_entries")
    .insert({
      organization_id: organizationId,
      variety_id: payload.varietyId,
      year: payload.isoYear,
      week: payload.isoWeek,
      size_kg: sizeKgById,
      average_fruit_weight_g: payload.averageFruitWeightG,
      ...totals
    })
    .select("id, variety_id, year, week, total_kg")
    .single();

  if (insertError || !inserted) {
    // Release the claims so the lots can be retried.
    const claimedLotNumbers = createImportRunRows.map((r) => r.lot_number);
    const { error: releaseError } = await supabase
      .from("yield_import_runs")
      .delete()
      .eq("organization_id", organizationId)
      .in("lot_number", claimedLotNumbers);
    if (releaseError) {
      console.error("PDF import history release failed (create mode):", {
        organizationId,
        lotNumbers: claimedLotNumbers,
        code: releaseError.code,
        message: releaseError.message
      });
    }
    return res.status(500).json({
      message: "Failed to import PDF preview data into weekly entry."
    });
  }

  return res.status(201).json({
    success: true,
    mode: "create",
    entry: inserted
  });
});
