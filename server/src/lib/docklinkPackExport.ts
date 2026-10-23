// Validation for DockLink's pack export (contract "docklink.growlink.pack_export",
// version 1), returned by rpc('growlink_pack_export_v1', { p_organization_id }).
//
// Every rule is checked here, before anything is written: the contract and
// version, the organization, the scope, row identities, week consistency and
// quantities. A document that fails any check is rejected whole — the sync
// applies nothing (see apply_docklink_pack_export, migration 0143, which
// re-checks the critical rules inside the transaction).

export const PACK_EXPORT_CONTRACT = "docklink.growlink.pack_export";
export const PACK_EXPORT_VERSION = 1;
export const PACK_EXPORT_RPC = "growlink_pack_export_v1";

export type ScopeStatus = "available" | "pending_first_full_week" | "capture_not_active";
const SCOPE_STATUSES: ScopeStatus[] = ["available", "pending_first_full_week", "capture_not_active"];

export type IsoWeekRef = { iso_year: number; iso_week: number; week_start: string };

export type PackExportScope = {
  status: ScopeStatus;
  capture_activated_at: string | null;
  transition_week: IsoWeekRef | null;
  first_week: IsoWeekRef | null;
  last_week: IsoWeekRef | null;
};

export type PackCatalogEntry = {
  pack_id: string;
  name: string;
  pack_code: string | null;
  description: string | null;
  color_label: string | null;
  color_key: string | null;
  color_kind: string | null;
  display_order: number | null;
  crop_type: string | null;
  tracking_unit: string | null;
  status: string;
  archived_at: string | null;
  updated_at: string | null;
};

export type WeeklyPackTotal = {
  iso_year: number;
  iso_week: number;
  week_start: string;
  series_key: string;
  attribution: "pack" | "unattributed";
  pack_id: string | null;
  source_pack_ref: string | null;
  pack_name: string | null;
  pack_code: string | null;
  color_key: string | null;
  color_kind: string | null;
  crop_type: string | null;
  tracking_unit: string | null;
  total_cases: number;
  load_count: number;
  line_count: number;
};

export type NormalizedPackExport = {
  contract: typeof PACK_EXPORT_CONTRACT;
  version: typeof PACK_EXPORT_VERSION;
  organization_id: string;
  generated_at: string;
  week_rule: string | null;
  scope: PackExportScope;
  packs: PackCatalogEntry[];
  weekly_pack_totals: WeeklyPackTotal[];
  diagnostics: Record<string, unknown>;
};

export class PackExportContractError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`DockLink pack export failed validation: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`);
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// ISO 8601 weeks (UTC)
// ---------------------------------------------------------------------------

/** Monday (UTC) of ISO week `week` of ISO year `year`, as yyyy-mm-dd. */
export function isoWeekStart(year: number, week: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7; // Monday = 0
  const week1Monday = Date.UTC(year, 0, 4 - jan4Weekday);
  return new Date(week1Monday + (week - 1) * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** 52 or 53. */
export function isoWeeksInYear(year: number): number {
  const dec28 = new Date(Date.UTC(year, 11, 28));
  const thursday = new Date(dec28);
  thursday.setUTCDate(dec28.getUTCDate() + 3 - ((dec28.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

export const weekOrdinal = (year: number, week: number) => year * 100 + week;

// ---------------------------------------------------------------------------
// Field readers — each records a problem rather than throwing, so one call
// reports every defect in the document.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class Reader {
  readonly problems: string[] = [];
  fail(message: string) {
    this.problems.push(message);
  }
  str(o: Obj, key: string, where: string): string | null {
    const v = o[key];
    if (typeof v !== "string" || v.trim() === "") {
      this.fail(`${where}.${key} must be a non-empty string`);
      return null;
    }
    return v;
  }
  optStr(o: Obj, key: string, where: string): string | null {
    const v = o[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      this.fail(`${where}.${key} must be a string or null`);
      return null;
    }
    return v;
  }
  timestamp(o: Obj, key: string, where: string, required: boolean): string | null {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) this.fail(`${where}.${key} is required`);
      return null;
    }
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
      this.fail(`${where}.${key} must be an ISO timestamp`);
      return null;
    }
    return v;
  }
  int(o: Obj, key: string, where: string, { min = 0, required = true }: { min?: number; required?: boolean } = {}): number | null {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) this.fail(`${where}.${key} is required`);
      return null;
    }
    const n = typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min) {
      this.fail(`${where}.${key} must be an integer >= ${min}`);
      return null;
    }
    return n;
  }
  /** A non-negative decimal: a JSON number or a plain decimal string ("1840", "12.5"). */
  quantity(o: Obj, key: string, where: string): number | null {
    const v = o[key];
    let n: number | null = null;
    if (typeof v === "number") n = v;
    else if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
    if (n === null || !Number.isFinite(n) || n < 0) {
      this.fail(`${where}.${key} must be a non-negative decimal (got ${JSON.stringify(v)})`);
      return null;
    }
    return n;
  }
  week(v: unknown, where: string, required: boolean): IsoWeekRef | null {
    if (v === undefined || v === null) {
      if (required) this.fail(`${where} is required`);
      return null;
    }
    if (!isObj(v)) {
      this.fail(`${where} must be an object`);
      return null;
    }
    const year = this.int(v, "iso_year", where, { min: 2000 });
    const week = this.int(v, "iso_week", where, { min: 1 });
    if (year === null || week === null) return null;
    if (week > isoWeeksInYear(year)) {
      this.fail(`${where}: ISO ${year} has no week ${week}`);
      return null;
    }
    const expectedStart = isoWeekStart(year, week);
    const weekStart = v.week_start;
    if (weekStart !== undefined && weekStart !== null && weekStart !== expectedStart) {
      this.fail(`${where}.week_start ${JSON.stringify(weekStart)} is not the Monday of ISO ${year}-W${week} (${expectedStart})`);
      return null;
    }
    return { iso_year: year, iso_week: week, week_start: expectedStart };
  }
}

/**
 * Validates and normalizes one export document for the DockLink organization
 * GrowLink has mapped (`expectedExternalOrganizationId`). Throws
 * PackExportContractError listing every problem found.
 */
export function validatePackExport(raw: unknown, expectedExternalOrganizationId: string): NormalizedPackExport {
  const r = new Reader();
  if (!isObj(raw)) throw new PackExportContractError(["export must be a JSON object"]);

  if (raw.contract !== PACK_EXPORT_CONTRACT) r.fail(`contract must be "${PACK_EXPORT_CONTRACT}" (got ${JSON.stringify(raw.contract)})`);
  if (raw.version !== PACK_EXPORT_VERSION) r.fail(`version must be ${PACK_EXPORT_VERSION} (got ${JSON.stringify(raw.version)})`);

  const organizationId = r.str(raw, "organization_id", "export");
  if (organizationId && organizationId.trim().toLowerCase() !== expectedExternalOrganizationId.trim().toLowerCase()) {
    r.fail("export.organization_id does not match the mapped DockLink organization");
  }
  const generatedAt = r.timestamp(raw, "generated_at", "export", true);
  const weekRule = r.optStr(raw, "week_rule", "export");

  // --- scope ---
  let scope: PackExportScope = { status: "capture_not_active", capture_activated_at: null, transition_week: null, first_week: null, last_week: null };
  if (!isObj(raw.scope)) {
    r.fail("export.scope must be an object");
  } else {
    const status = raw.scope.status as ScopeStatus;
    if (!SCOPE_STATUSES.includes(status)) r.fail(`scope.status must be one of ${SCOPE_STATUSES.join(", ")} (got ${JSON.stringify(raw.scope.status)})`);
    const available = status === "available";
    const first = r.week(raw.scope.first_week, "scope.first_week", available);
    const last = r.week(raw.scope.last_week, "scope.last_week", available);
    const transition = r.week(raw.scope.transition_week, "scope.transition_week", false);
    if (first && last && weekOrdinal(first.iso_year, first.iso_week) > weekOrdinal(last.iso_year, last.iso_week)) {
      r.fail("scope.first_week is after scope.last_week");
    }
    if (first && transition && weekOrdinal(transition.iso_year, transition.iso_week) >= weekOrdinal(first.iso_year, first.iso_week)) {
      r.fail("scope.transition_week must be before scope.first_week");
    }
    scope = {
      status: SCOPE_STATUSES.includes(status) ? status : "capture_not_active",
      capture_activated_at: r.timestamp(raw.scope, "capture_activated_at", "scope", false),
      transition_week: transition,
      first_week: available ? first : null,
      last_week: available ? last : null
    };
  }

  // --- packs ---
  const packs: PackCatalogEntry[] = [];
  if (!Array.isArray(raw.packs)) {
    r.fail("export.packs must be an array");
  } else {
    const seen = new Set<string>();
    raw.packs.forEach((p, i) => {
      const where = `packs[${i}]`;
      if (!isObj(p)) return r.fail(`${where} must be an object`);
      const packId = r.str(p, "pack_id", where);
      const name = r.str(p, "name", where);
      const status = r.str(p, "status", where);
      if (packId) {
        if (seen.has(packId)) r.fail(`${where}: duplicate pack_id ${packId}`);
        seen.add(packId);
      }
      const displayOrder = p.display_order === null || p.display_order === undefined ? null : Number(p.display_order);
      if (displayOrder !== null && !Number.isFinite(displayOrder)) r.fail(`${where}.display_order must be a number`);
      if (!packId || !name || !status) return;
      packs.push({
        pack_id: packId,
        name,
        pack_code: r.optStr(p, "pack_code", where),
        description: r.optStr(p, "description", where),
        color_label: r.optStr(p, "color_label", where),
        color_key: r.optStr(p, "color_key", where),
        color_kind: r.optStr(p, "color_kind", where),
        display_order: displayOrder !== null && Number.isFinite(displayOrder) ? displayOrder : null,
        crop_type: r.optStr(p, "crop_type", where),
        tracking_unit: r.optStr(p, "tracking_unit", where),
        status,
        archived_at: r.timestamp(p, "archived_at", where, false),
        updated_at: r.timestamp(p, "updated_at", where, false)
      });
    });
  }

  // --- weekly totals ---
  // Only meaningful when DockLink declares a scope authoritative. Rows sent
  // with any other status are not applied.
  const totals: WeeklyPackTotal[] = [];
  if (!Array.isArray(raw.weekly_pack_totals)) {
    r.fail("export.weekly_pack_totals must be an array");
  } else if (scope.status === "available" && scope.first_week && scope.last_week) {
    const firstOrd = weekOrdinal(scope.first_week.iso_year, scope.first_week.iso_week);
    const lastOrd = weekOrdinal(scope.last_week.iso_year, scope.last_week.iso_week);
    const identities = new Set<string>();
    raw.weekly_pack_totals.forEach((row, i) => {
      const where = `weekly_pack_totals[${i}]`;
      if (!isObj(row)) return r.fail(`${where} must be an object`);
      const week = r.week(row, where, true);
      const seriesKey = r.str(row, "series_key", where);
      const totalCases = r.quantity(row, "total_cases", where);
      const loadCount = r.int(row, "load_count", where, { required: false }) ?? 0;
      const lineCount = r.int(row, "line_count", where, { required: false }) ?? 0;
      const attribution = row.attribution;
      const packId = row.pack_id === undefined ? null : row.pack_id;
      if (attribution !== "pack" && attribution !== "unattributed") {
        r.fail(`${where}.attribution must be "pack" or "unattributed"`);
      } else if (attribution === "pack" && (typeof packId !== "string" || packId.trim() === "")) {
        r.fail(`${where}: attribution "pack" requires a pack_id`);
      } else if (attribution === "unattributed" && packId !== null) {
        r.fail(`${where}: attribution "unattributed" must have pack_id null`);
      }
      if (!week || !seriesKey || totalCases === null) return;
      const ord = weekOrdinal(week.iso_year, week.iso_week);
      if (ord < firstOrd || ord > lastOrd) {
        r.fail(`${where}: ISO ${week.iso_year}-W${week.iso_week} is outside the authoritative scope`);
        return;
      }
      const identity = `${week.iso_year}:${week.iso_week}:${seriesKey}`;
      if (identities.has(identity)) {
        r.fail(`${where}: duplicate identity (${week.iso_year}, ${week.iso_week}, ${seriesKey})`);
        return;
      }
      identities.add(identity);
      if (attribution !== "pack" && attribution !== "unattributed") return;
      totals.push({
        ...week,
        series_key: seriesKey,
        attribution,
        pack_id: attribution === "pack" ? (packId as string) : null,
        source_pack_ref: r.optStr(row, "source_pack_ref", where),
        pack_name: r.optStr(row, "pack_name", where),
        pack_code: r.optStr(row, "pack_code", where),
        color_key: r.optStr(row, "color_key", where),
        color_kind: r.optStr(row, "color_kind", where),
        crop_type: r.optStr(row, "crop_type", where),
        tracking_unit: r.optStr(row, "tracking_unit", where),
        total_cases: totalCases,
        load_count: loadCount,
        line_count: lineCount
      });
    });
  }

  if (r.problems.length > 0) throw new PackExportContractError(r.problems);

  return {
    contract: PACK_EXPORT_CONTRACT,
    version: PACK_EXPORT_VERSION,
    organization_id: organizationId as string,
    generated_at: generatedAt as string,
    week_rule: weekRule,
    scope,
    packs,
    weekly_pack_totals: totals,
    diagnostics: isObj(raw.diagnostics) ? raw.diagnostics : {}
  };
}
