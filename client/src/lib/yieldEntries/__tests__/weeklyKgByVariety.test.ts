import { describe, expect, it } from "vitest";
import {
  buildWeeklyKgTable,
  csvKgValue,
  displayMatrix,
  formatKgCell,
  parseWeeklyKgSource,
  roundKg1,
  tableHeader,
  weeklyKgCsv,
  weeklyKgFileBase,
  type WeeklyKgByVarietySource
} from "../weeklyKgByVariety";

const source = (over: Partial<WeeklyKgByVarietySource> = {}): WeeklyKgByVarietySource => ({
  year: 2026,
  years: [2026, 2025],
  entryCount: 0,
  varieties: [
    { id: "v-b", name: "Silverstone", status: "active" },
    { id: "v-a", name: "Cadalora", status: "active" },
    { id: "v-old", name: "Levente", status: "inactive" }
  ],
  entries: [],
  ...over
});
const e = (variety_id: string, week: number, total_kg: number) => ({ variety_id, week, total_kg });

// Parses this module's own CSV (RFC 4180) back into fields.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else field += ch;
  }
  return rows;
}

describe("buildWeeklyKgTable", () => {
  it("sums every entry of a variety and week once, spans first to last week, and keeps zeros distinct from no entry", () => {
    const table = buildWeeklyKgTable(
      source({
        entryCount: 6,
        entries: [
          e("v-a", 30, 1000.25),
          e("v-a", 30, 500.5), // a second entry for the same variety and week
          e("v-b", 30, 0), // an explicitly recorded zero
          e("v-a", 33, 12345.678),
          e("v-old", 33, 40), // inactive variety with historical entries
          e("v-b", 34, 7)
        ]
      })
    )!;
    expect(table.columns.map((c) => [c.id, c.label, c.inactive])).toEqual([
      ["v-a", "Cadalora", false],
      ["v-old", "Levente (inactive)", true],
      ["v-b", "Silverstone", false]
    ]);
    expect(table.rows.map((r) => r.week)).toEqual([30, 31, 32, 33, 34]);
    expect(table.rows[0].cells).toEqual([1500.75, null, 0]);
    expect(table.rows[0].total).toBe(1500.75);
    expect(table.rows[1]).toEqual({ week: 31, cells: [null, null, null], total: null });
    expect(table.rows[3].cells).toEqual([12345.678, 40, null]);
    expect(table.seasonTotals).toEqual([1500.75 + 12345.678, 40, 7]);
    expect(table.seasonTotal).toBeCloseTo(13893.428, 9);

    const { body, foot } = displayMatrix(table);
    expect(tableHeader(table)).toEqual(["Week", "Cadalora", "Levente (inactive)", "Silverstone", "Weekly total"]);
    expect(body).toEqual([
      ["Week 30", "1,500.8", "—", "0.0", "1,500.8"],
      ["Week 31", "—", "—", "—", "—"],
      ["Week 32", "—", "—", "—", "—"],
      ["Week 33", "12,345.7", "40.0", "—", "12,385.7"],
      ["Week 34", "—", "—", "7.0", "7.0"]
    ]);
    expect(foot).toEqual(["Season total", "13,846.4", "40.0", "7.0", "13,893.4"]);
  });

  it("totals from full-precision kg, not from the rounded cells", () => {
    const table = buildWeeklyKgTable(
      source({ entryCount: 3, entries: [e("v-a", 1, 0.04), e("v-b", 1, 0.04), e("v-old", 1, 0.04)] })
    )!;
    const { body, foot } = displayMatrix(table);
    // Each cell rounds to 0.0, but the week holds 0.12 kg.
    expect(body[0]).toEqual(["Week 1", "0.0", "0.0", "0.0", "0.1"]);
    expect(foot[foot.length - 1]).toBe("0.1");
  });

  it("groups by variety id, so two varieties sharing a name stay separate columns with distinct headers", () => {
    const table = buildWeeklyKgTable(
      source({
        entryCount: 2,
        varieties: [
          { id: "v-1", name: "Trial", status: "active" },
          { id: "v-2", name: "Trial", status: "active" }
        ],
        entries: [e("v-2", 5, 2), e("v-1", 5, 3)]
      })
    )!;
    expect(table.columns.map((c) => [c.id, c.label])).toEqual([
      ["v-1", "Trial"],
      ["v-2", "Trial (2)"]
    ]);
    expect(table.rows[0].cells).toEqual([3, 2]);
  });

  it("returns null for a year with no entries, and refuses unreadable data rather than skipping it", () => {
    expect(buildWeeklyKgTable(source())).toBeNull();
    expect(buildWeeklyKgTable(source({ year: null, years: [] }))).toBeNull();
    expect(() => buildWeeklyKgTable(source({ entries: [e("v-a", 3, Number.NaN)] }))).toThrow();
  });
});

describe("formatting", () => {
  it("rounds once, half away from zero, then formats with separators (card/PDF) or plainly (CSV)", () => {
    expect([0.05, 0.15, 1.25, 2.349, 1234567.85, 0].map(roundKg1)).toEqual([0.1, 0.2, 1.3, 2.3, 1234567.9, 0]);
    expect(formatKgCell(1234567.85)).toBe("1,234,567.9");
    expect(formatKgCell(0)).toBe("0.0");
    expect(formatKgCell(null)).toBe("—");
    expect(csvKgValue(1234567.85)).toBe("1234567.9");
    expect(csvKgValue(0)).toBe("0.0");
    expect(csvKgValue(null)).toBe("");
    expect(weeklyKgFileBase(2026)).toBe("weekly-kg-by-variety-2026");
  });
});

describe("weeklyKgCsv", () => {
  it("exports the full table: same columns and rows as the card, kg as plain one-decimal numbers", () => {
    const table = buildWeeklyKgTable(
      source({ entryCount: 4, entries: [e("v-a", 30, 1500.75), e("v-b", 30, 0), e("v-a", 33, 12345.678), e("v-old", 33, 40)] })
    )!;
    const csv = weeklyKgCsv(table);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const rows = parseCsv(csv.slice(1));
    expect(rows[0]).toEqual(tableHeader(table));
    expect(rows.slice(1)).toEqual([
      ["30", "1500.8", "", "0.0", "1500.8"],
      ["31", "", "", "", ""],
      ["32", "", "", "", ""],
      ["33", "12345.7", "40.0", "", "12385.7"],
      ["Season total", "13846.4", "40.0", "0.0", "13886.4"]
    ]);
    // Every value matches the card's, once its thousands separators are removed.
    const { body, foot } = displayMatrix(table);
    const asCsv = (s: string) => (s === "—" ? "" : s.replace(/,/g, ""));
    expect(rows.slice(1, -1).map((r) => r.slice(1))).toEqual(body.map((r) => r.slice(1).map(asCsv)));
    expect(rows[rows.length - 1].slice(1)).toEqual(foot.slice(1).map(asCsv));
  });

  it("escapes commas, quotes and line breaks, and neutralizes spreadsheet formulas in names", () => {
    const table = buildWeeklyKgTable(
      source({
        entryCount: 3,
        varieties: [
          { id: "v-1", name: 'Red, "large"', status: "active" },
          { id: "v-2", name: "Line\nbreak", status: "active" },
          { id: "v-3", name: "=HYPERLINK(\"x\")", status: "active" }
        ],
        entries: [e("v-1", 1, 1), e("v-2", 1, 2), e("v-3", 1, 3)]
      })
    )!;
    const csv = weeklyKgCsv(table);
    // Columns sort by name ("=" sorts first).
    expect(csv.split("\r\n")[0]).toBe("\uFEFF" + 'Week,"\'=HYPERLINK(""x"")","Line\nbreak","Red, ""large""",Weekly total');
    expect(parseCsv(csv.slice(1))[0]).toEqual(["Week", "'=HYPERLINK(\"x\")", "Line\nbreak", 'Red, "large"', "Weekly total"]);
  });
});

describe("parseWeeklyKgSource", () => {
  const good = source({ entryCount: 1, entries: [e("v-a", 3, 1)] });
  it("accepts the server's shape", () => {
    expect(parseWeeklyKgSource(good)).toBe(good);
    expect(parseWeeklyKgSource(source({ year: null, years: [] }))).toEqual(source({ year: null, years: [] }));
  });
  it.each([
    ["an array", []],
    ["null", null],
    ["an error page", "<html>502</html>"],
    ["a body without entries", { year: 2026, years: [2026], entryCount: 0, varieties: [] }],
    ["entries that don't match their count", { ...good, entryCount: 2 }],
    ["an entry with a non-integer week", { ...good, entries: [e("v-a", 3.5, 1)] }],
    ["an entry with unreadable kg", { ...good, entries: [{ variety_id: "v-a", week: 3, total_kg: "abc" }] }]
  ])("rejects %s rather than showing a partial season", (_label, body) => {
    expect(() => parseWeeklyKgSource(body)).toThrow("Weekly kg by variety came back incomplete");
  });
});
