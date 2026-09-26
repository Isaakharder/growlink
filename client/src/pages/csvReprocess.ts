// Response shape and user-facing wording for reprocessing pending CSV
// sources against the current templates (server: reprocessPendingCsvSources
// in csvMappingTemplates.ts). Kept free of React so the wording is easy to
// test on its own.

export const REPROCESS_URL = "/api/csv-templates/pending/reprocess";
export const REPROCESS_PLAN_URL = "/api/csv-templates/pending/reprocess-plan";

export type TemplateLabel = { id: string; name: string; version: number };

export type ReprocessSourceResult = {
  pendingImportId: string;
  sourceFileId: string | null;
  sourceFilename: string;
  outcome: "updated" | "unchanged" | "failed";
  previousTemplate: TemplateLabel | null;
  template: TemplateLabel | null;
  needsTemplate: boolean;
  error: string | null;
};

export type ReprocessResult = {
  dryRun: boolean;
  total: number;
  updated: number;
  unchanged: number;
  failed: number;
  skippedImported: number;
  targetTemplates: Array<TemplateLabel & { sourceCount: number }>;
  results: ReprocessSourceResult[];
};

export function reprocessPlanUrl(pendingImportIds?: string[]): string {
  return pendingImportIds && pendingImportIds.length > 0
    ? `${REPROCESS_PLAN_URL}?pendingImportIds=${encodeURIComponent(pendingImportIds.join(","))}`
    : REPROCESS_PLAN_URL;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function templateList(plan: ReprocessResult): string {
  return plan.targetTemplates.map((t) => `${t.name} v${t.version}`).join(", ");
}

/** The confirmation shown before a real run, from a dry-run plan. */
export function reprocessConfirmationText(plan: ReprocessResult, scope: "all" | "card"): string {
  if (plan.total === 0) return "There are no pending source files to reprocess.";
  const subject =
    scope === "card"
      ? `Reprocess all ${plural(plan.total, "source file")} on this card`
      : `Reprocess ${plural(plan.total, "pending source file")}`;
  const using = plan.targetTemplates.length > 0 ? ` using ${templateList(plan)}` : "";
  return `${subject}${using}? This will update their previews and warnings but will not import anything.`;
}

/** Extra lines for the confirmation: files that would lose their template match. */
export function reprocessConfirmationNotes(plan: ReprocessResult): string[] {
  const notes: string[] = [];
  const toNeedsTemplate = plan.results.filter((r) => r.needsTemplate && r.previousTemplate !== null).length;
  if (toNeedsTemplate > 0) {
    notes.push(`${plural(toNeedsTemplate, "file")} no longer ${toNeedsTemplate === 1 ? "matches" : "match"} an active template and will need one set up.`);
  }
  if (plan.skippedImported > 0) notes.push(`${plural(plan.skippedImported, "already-imported file")} will be skipped.`);
  return notes;
}

/** "12 files updated · 1 unchanged · 1 failed" */
export function reprocessSummaryText(result: ReprocessResult): string {
  const parts = [`${plural(result.updated, "file")} updated`, `${result.unchanged} unchanged`, `${result.failed} failed`];
  if (result.skippedImported > 0) parts.push(`${result.skippedImported} already imported (skipped)`);
  return parts.join(" · ");
}
