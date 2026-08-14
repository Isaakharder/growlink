// Pure size-name matching/classification logic shared by pdfImport.ts and
// agentPendingImports.ts. Deliberately has no dependency on the Supabase
// client (unlike those two route files) so it can be imported directly in
// unit tests without needing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set.
import { applySizeRules, type SizeRuleRecord } from "./flowMasterSizeRules";

export const KNOWN_SIZE_LABEL_MAP: Record<string, string> = {
  SM: "Small",
  MD: "Medium",
  LG: "Large",
  SXL: "SXL",
  XL: "XL",
  XXL: "XXL"
};

export const KNOWN_SIZE_TARGET_TO_LABEL = Object.entries(KNOWN_SIZE_LABEL_MAP).reduce<Record<string, string>>(
  (acc, [label, target]) => {
    acc[target] = label;
    return acc;
  },
  {}
);

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

export type OrgSizeContext = {
  activeYieldSizeNameByCanonical: Map<string, string>;
  activeSizeNameById: Map<string, string>;
  rulesByNormalizedLabel: Map<string, SizeRuleRecord>;
};

export type SizeMappingClassification = {
  sizeMappingStatus: {
    mappedCount: number;
    unmappedCount: number;
    mapped: Array<{ pdfSize: string; growlinkSize: string }>;
    unmapped: string[];
  };
  unknownSizes: string[];
  sizeWarnings: string[];
};

// Classifies every sizeKg key against the org's active sizes by canonical
// name match. Callers should run applySizeRules first so labels resolved
// by a saved rule are already folded into a real size name by the time
// this runs — this function only does the final name-canonicalization
// check, unaware of rules.
export function classifySizeMapping(
  sizeKg: Record<string, number>,
  unknownSizesSeed: string[],
  activeYieldSizeNameByCanonical: Map<string, string>
): SizeMappingClassification {
  const unknownSizeSet = new Set<string>(unknownSizesSeed);
  const mapped: Array<{ pdfSize: string; growlinkSize: string }> = [];
  const sizeWarnings: string[] = [];

  for (const parsedSizeName of Object.keys(sizeKg)) {
    const canonical = canonicalizeSizeName(parsedSizeName);
    const activeSizeName = activeYieldSizeNameByCanonical.get(canonical);
    const pdfSizeLabel = KNOWN_SIZE_TARGET_TO_LABEL[parsedSizeName] ?? parsedSizeName;

    if (activeSizeName) {
      mapped.push({ pdfSize: pdfSizeLabel, growlinkSize: activeSizeName });
    } else {
      unknownSizeSet.add(pdfSizeLabel);
      sizeWarnings.push(`New size found: ${pdfSizeLabel}. Add this size in GrowLink before importing.`);
    }
  }

  const unknownSizes = Array.from(unknownSizeSet);

  return {
    sizeMappingStatus: {
      mappedCount: mapped.length,
      unmappedCount: unknownSizes.length,
      mapped,
      unmapped: unknownSizes
    },
    unknownSizes,
    sizeWarnings
  };
}

export type ResolvedFileSizes = SizeMappingClassification & {
  sizeKg: Record<string, number>;
  ruleNotes: string[];
};

// Applies saved size rules, then classifies whatever's left against the
// org's active sizes. The single entry point every call site (preview,
// remap-sizes, agent pending imports) should use to resolve a file's raw
// sizeKg/unknownSizes into their final, import-ready state.
export function resolveFileSizes(
  sizeKg: Record<string, number>,
  unknownSizes: string[],
  ctx: OrgSizeContext
): ResolvedFileSizes {
  const ruleResult = applySizeRules(sizeKg, unknownSizes, ctx.rulesByNormalizedLabel, ctx.activeSizeNameById);
  const classification = classifySizeMapping(
    ruleResult.sizeKg,
    ruleResult.unknownSizes,
    ctx.activeYieldSizeNameByCanonical
  );

  return {
    sizeKg: ruleResult.sizeKg,
    ...classification,
    ruleNotes: ruleResult.notes
  };
}
