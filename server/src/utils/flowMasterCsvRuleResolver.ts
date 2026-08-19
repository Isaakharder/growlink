// Re-derives a CSV file's sizeKg/unknownSizes from its raw per-row MARKET/
// SIZE1/kg facts (CsvRowKg), this time with saved flowmaster_size_rules
// factored into the MARKET-vs-SIZE1 priority decision.
//
// Why this exists: flowMasterCsvParser.ts is a pure, DB-free function — at
// parse time it can only check the org's static ignoredSizeLabels/sizeAliases
// settings (passed in as plain arguments) when deciding whether MARKET or
// SIZE1 is a given row's resolution label. It has no way to know whether the
// org has since saved a flowmaster_size_rules entry for a MARKET value like
// "waste" — so on its own, a row like MARKET=waste/SIZE1=SM always falls
// through to SIZE1's direct code and becomes "Small", even if the org later
// configures "waste" as an Ignore rule.
//
// This module fixes that by re-running the SAME classifyNewFormatRow priority
// logic (MARKET first, then SIZE1) with an hasOverride check that ALSO
// consults rulesByNormalizedLabel — i.e. it decides which raw label a row's
// kg belongs to, exactly like the parser does, but this time MARKET-aware
// rules are visible. The actual ignore/map/distribute APPLICATION still goes
// through the existing, shared applySizeRules (via resolveFileSizes) — this
// module only fixes which label a row's kg is filed under before that shared
// engine runs, so PDF import (which never produces CsvRowKg) is unaffected.
//
// Callers: pdfImport.ts's /pdf-import/preview and agentPendingImports.ts's
// buildPreviewFile, both immediately before calling resolveFileSizes — see
// those files for exact wiring.

import {
  classifyNewFormatRow,
  resolveLabel,
  normalizeForMatch,
  buildMergedAliasesNormalized,
  type LabelOverrideCheck,
} from "./flowMasterCsvParser";
import { normalizeSizeRuleLabel, type SizeRuleRecord } from "./flowMasterSizeRules";
import { type CsvRowKg } from "./flowMasterPdfParser";

export type ResolvedCsvRowLabels = {
  sizeKg: Record<string, number>;
  unknownSizes: string[];
};

export function resolveCsvRowLabels(
  rows: CsvRowKg[],
  ignoredSizeLabels: string[],
  sizeAliases: Record<string, string>,
  rulesByNormalizedLabel: Map<string, SizeRuleRecord>
): ResolvedCsvRowLabels {
  const mergedAliasesNormalized = buildMergedAliasesNormalized(sizeAliases);
  const ignoredSet = new Set(ignoredSizeLabels.map((l) => normalizeForMatch(l)));

  // MARKET wins priority over a direct SIZE1 code the moment it has ANY
  // configured resolution — legacy ignore/alias settings, or a saved
  // flowmaster_size_rules row (any action: ignore, map, create, distribute).
  // Which action actually applies is decided afterward by applySizeRules
  // (via resolveFileSizes) on the sizeKg/unknownSizes this function returns.
  const hasOverride: LabelOverrideCheck = (label) => {
    const matchKey = normalizeForMatch(label);
    return (
      ignoredSet.has(matchKey) ||
      mergedAliasesNormalized[matchKey] !== undefined ||
      rulesByNormalizedLabel.has(normalizeSizeRuleLabel(label))
    );
  };

  const sizeKg: Record<string, number> = {};
  const unknownSizes: string[] = [];

  for (const row of rows) {
    if (!Number.isFinite(row.kg) || row.kg === 0) continue;

    const label = classifyNewFormatRow(row.marketLabel, row.size1Label, hasOverride);
    if (!label) continue;

    const resolution = resolveLabel(label, ignoredSet, mergedAliasesNormalized);

    if (resolution.kind === "ignored") continue;

    if (resolution.kind === "unresolved") {
      if (!unknownSizes.includes(label)) {
        unknownSizes.push(label);
      }
      sizeKg[label] = (sizeKg[label] ?? 0) + row.kg;
      continue;
    }

    sizeKg[resolution.sizeName] = (sizeKg[resolution.sizeName] ?? 0) + row.kg;
  }

  return { sizeKg, unknownSizes };
}
