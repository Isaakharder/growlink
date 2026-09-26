import { describe, expect, it } from "vitest";
import {
  reprocessConfirmationNotes,
  reprocessConfirmationText,
  reprocessPlanUrl,
  reprocessSummaryText,
  type ReprocessResult
} from "../csvReprocess";

function result(overrides: Partial<ReprocessResult> = {}): ReprocessResult {
  return {
    dryRun: false,
    total: 14,
    updated: 12,
    unchanged: 1,
    failed: 1,
    skippedImported: 0,
    targetTemplates: [{ id: "t13", name: "Latest Mapping", version: 13, sourceCount: 14 }],
    results: [],
    ...overrides
  };
}

describe("reprocess wording", () => {
  it("summarizes a run as updated · unchanged · failed", () => {
    expect(reprocessSummaryText(result())).toBe("12 files updated · 1 unchanged · 1 failed");
    expect(reprocessSummaryText(result({ updated: 1, unchanged: 0, failed: 0 }))).toBe("1 file updated · 0 unchanged · 0 failed");
    expect(reprocessSummaryText(result({ skippedImported: 2 }))).toBe("12 files updated · 1 unchanged · 1 failed · 2 already imported (skipped)");
  });

  it("confirms the whole batch with the target template and a no-import promise", () => {
    expect(reprocessConfirmationText(result({ dryRun: true }), "all")).toBe(
      "Reprocess 14 pending source files using Latest Mapping v13? This will update their previews and warnings but will not import anything."
    );
  });

  it("says a card action reprocesses every source on the card", () => {
    expect(reprocessConfirmationText(result({ total: 3 }), "card")).toBe(
      "Reprocess all 3 source files on this card using Latest Mapping v13? This will update their previews and warnings but will not import anything."
    );
  });

  it("handles an empty queue", () => {
    expect(reprocessConfirmationText(result({ total: 0, targetTemplates: [] }), "all")).toBe("There are no pending source files to reprocess.");
  });

  it("notes files that would lose their template match and skipped imports", () => {
    const plan = result({
      skippedImported: 1,
      results: [
        {
          pendingImportId: "p1",
          sourceFileId: "s1",
          sourceFilename: "a.csv",
          outcome: "updated",
          previousTemplate: { id: "t11", name: "Latest Mapping", version: 11 },
          template: null,
          needsTemplate: true,
          error: null
        }
      ]
    });
    expect(reprocessConfirmationNotes(plan)).toEqual([
      "1 file no longer matches an active template and will need one set up.",
      "1 already-imported file will be skipped."
    ]);
  });

  it("builds the plan URL for all sources or a card's sources", () => {
    expect(reprocessPlanUrl()).toBe("/api/csv-templates/pending/reprocess-plan");
    expect(reprocessPlanUrl(["a", "b"])).toBe("/api/csv-templates/pending/reprocess-plan?pendingImportIds=a%2Cb");
  });
});
