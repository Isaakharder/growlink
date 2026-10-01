import { describe, expect, it } from "vitest";
import { buildWeeklyKgTable, displayMatrix, tableHeader, type WeeklyKgByVarietySource } from "../weeklyKgByVariety";
import { buildWeeklyKgPdf } from "../weeklyKgByVarietyPdf";

// The PDF is generated for real and its text read back from the
// (uncompressed) content streams, so these tests check what a reader sees.

const VARIETY_COUNT = 30;
function wideSource(): WeeklyKgByVarietySource {
  const varieties = Array.from({ length: VARIETY_COUNT }, (_, i) => ({
    id: `v-${String(i).padStart(2, "0")}`,
    name: `Variety ${String(i + 1).padStart(2, "0")}`,
    status: i === 7 ? "inactive" : "active"
  }));
  const entries = varieties.flatMap((v, i) =>
    Array.from({ length: 52 }, (_, w) => w + 1)
      .filter((week) => (week + i) % 5 !== 0) // leave gaps
      .map((week) => ({
        variety_id: v.id,
        week,
        // A recorded zero, ordinary weeks, and one variety big enough for seven-figure totals.
        total_kg: week === 10 && i === 3 ? 0 : i === 0 ? 98765.43 + week : 1000 + i * 37.37 + week * 11.11
      }))
  );
  return { year: 2026, years: [2026], entryCount: entries.length, varieties, entries };
}

/** Every text-showing string in the PDF, decoded (WinAnsi em dash, escaped parentheses). */
function pdfStrings(pdf: string): string[] {
  return [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) =>
    m[1].replace(/\\([()\\])/g, "$1").replace(/\x97/g, "—").replace(/\xb7/g, "·")
  );
}

describe("buildWeeklyKgPdf", () => {
  const table = buildWeeklyKgTable(wideSource())!;
  const doc = buildWeeklyKgPdf(table, { organizationName: "First Light Greenhouses", exportedAt: new Date(2026, 9, 1, 15, 0) });
  const pdf = doc.output();
  const strings = pdfStrings(pdf);
  const pages = doc.getNumberOfPages();

  it("is landscape A4 with the title, organization, year, units and export date", () => {
    const box = pdf.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)!;
    expect(Number(box[1])).toBeCloseTo(841.89, 1); // A4, landscape
    expect(Number(box[2])).toBeCloseTo(595.28, 1);
    expect(strings).toContain("Weekly kg by Variety");
    const meta = strings.join("\n");
    expect(meta).toContain("First Light Greenhouses");
    expect(meta).toContain("2026");
    expect(meta).toContain("Units: kg");
    expect(meta).toContain("Exported 2026-10-01");
  });

  it("contains every week, variety, weekly total and season total exactly as the card shows them", () => {
    const { body, foot } = displayMatrix(table);
    const available = new Map<string, number>();
    for (const s of strings) available.set(s, (available.get(s) ?? 0) + 1);
    const needed = new Map<string, number>();
    for (const cell of [...body.flat(), ...foot]) needed.set(cell, (needed.get(cell) ?? 0) + 1);
    for (const [cell, count] of needed) {
      expect(available.get(cell) ?? 0, `"${cell}"`).toBeGreaterThanOrEqual(count);
    }
    for (const label of tableHeader(table)) expect(strings.join(" "), label).toContain(label);
    expect(body).toHaveLength(52);
    // Seven-figure totals are present and unwrapped (each is one string above).
    expect(foot[1]).toMatch(/^\d,\d{3},\d{3}\.\d$/);
    expect(foot[foot.length - 1]).toMatch(/^\d,\d{3},\d{3}\.\d$/);
    expect(strings).toContain("Season total");
  });

  it("splits many varieties across pages instead of shrinking text, repeating the Week column and headers", () => {
    expect(pages).toBeGreaterThan(1);
    // Week (column 0) is repeated on every horizontal page, with the header row.
    expect(strings.filter((s) => s === "Week").length).toBeGreaterThanOrEqual(pages);
    expect(strings.filter((s) => s === "Week 1").length).toBeGreaterThanOrEqual(2);
    // No text is set below 8 pt.
    const sizes = [...pdf.matchAll(/\/F\d+ ([\d.]+) Tf/g)].map((m) => Number(m[1]));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(8);
    for (let page = 1; page <= pages; page += 1) expect(strings).toContain(`Page ${page} of ${pages}`);
  });

  it("names the organization generically when it is unknown", () => {
    const fallback = pdfStrings(buildWeeklyKgPdf(table, { organizationName: null, exportedAt: new Date(2026, 9, 1) }).output()).join("\n");
    expect(fallback).toContain("Organization");
  });
});
