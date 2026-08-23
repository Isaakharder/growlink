// Structural layout fingerprint for saved CSV mapping templates. Built only
// from structure — delimiter, header-row position, normalized header
// values (which already encode duplicate-header positions, since the array
// is position-indexed), and column count — never from changing data values
// like dates, varieties, lot numbers, or weights, so the same physical CSV
// layout fingerprints identically no matter which week's export it is.
import { createHash } from "node:crypto";
import type { FingerprintMatchKind, TemplateFingerprint } from "./csvTemplateTypes";

export function computeFingerprint(
  grid: string[][],
  delimiter: string,
  headerRowIndex: number
): TemplateFingerprint {
  const headerRow = grid[headerRowIndex] ?? [];
  const columnCount = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const headers = normalizeHeaders(headerRow, columnCount);

  return { delimiter, headerRowIndex, headers, columnCount };
}

function normalizeHeaders(headerRow: string[], columnCount: number): string[] {
  const headers: string[] = [];
  for (let i = 0; i < columnCount; i += 1) {
    headers.push((headerRow[i] ?? "").trim().toUpperCase());
  }
  return headers;
}

export function computeFingerprintHash(fingerprint: TemplateFingerprint): string {
  const canonical = JSON.stringify({
    delimiter: fingerprint.delimiter,
    headerRowIndex: fingerprint.headerRowIndex,
    headers: fingerprint.headers,
    columnCount: fingerprint.columnCount
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export type FingerprintCandidate = {
  id: string;
  name: string;
  fingerprint: TemplateFingerprint;
  fingerprintHash: string;
};

export type FingerprintMatchResult = {
  kind: FingerprintMatchKind;
  template: FingerprintCandidate | null;
  similarity?: number;
};

const CLOSE_MATCH_THRESHOLD = 0.7;

/**
 * Exact hash match -> "exact" (auto-select). Same delimiter + header row
 * with >= 70% of header cells matching by position -> "close" (warn,
 * require review). Otherwise -> "none" (open the builder).
 */
export function matchFingerprint(
  candidate: TemplateFingerprint,
  candidateHash: string,
  savedTemplates: FingerprintCandidate[]
): FingerprintMatchResult {
  const exact = savedTemplates.find((t) => t.fingerprintHash === candidateHash);
  if (exact) {
    return { kind: "exact", template: exact };
  }

  let bestClose: FingerprintCandidate | null = null;
  let bestSimilarity = 0;

  for (const t of savedTemplates) {
    if (t.fingerprint.delimiter !== candidate.delimiter) continue;
    if (t.fingerprint.headerRowIndex !== candidate.headerRowIndex) continue;

    const similarity = headerOverlapRatio(candidate.headers, t.fingerprint.headers);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestClose = t;
    }
  }

  if (bestClose && bestSimilarity >= CLOSE_MATCH_THRESHOLD) {
    return { kind: "close", template: bestClose, similarity: bestSimilarity };
  }

  return { kind: "none", template: null };
}

function headerOverlapRatio(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  if (len === 0) return 1;

  let matches = 0;
  for (let i = 0; i < len; i += 1) {
    if ((a[i] ?? "") === (b[i] ?? "")) matches += 1;
  }

  return matches / len;
}
