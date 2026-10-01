import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Kg Entries → "Weekly kg by Variety": the card's table, year selector,
// states and exports (checked against the same table), and its refresh after
// an entry is saved through the real Kg Entries tab.
type Reply = { status: number; body: unknown };
const server = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: string }>,
  weekly: {} as Record<string, () => Reply | Promise<Reply>>
}));
vi.mock("../../../lib/api", () => ({
  getOrganizationName: () => Promise.resolve("First Light Greenhouses"),
  apiFetch: async (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    server.calls.push({ path, method, body: options.body });
    let reply: Reply = { status: 200, body: [] };
    if (path.startsWith("/api/yield-entries/weekly-by-variety")) {
      const year = new URL(path, "http://x").searchParams.get("year") ?? "latest";
      reply = await (server.weekly[year] ?? server.weekly.latest)();
    } else if (path === "/api/yield-entry-options") reply = { status: 200, body: { varieties: [{ id: "v-a", name: "Cadalora", area_m2: 1000, case_kg: 5, status: "active", color: "red" }], yieldSizes: [{ id: "s", name: "Small", sort_order: 1, status: "active" }] } };
    else if (path.startsWith("/api/yield-entries/recent")) reply = { status: 200, body: { entries: [], nextCursor: null, hasMore: false } };
    else if (path.startsWith("/api/agent-pending-imports")) reply = { status: 200, body: { weeks: [] } };
    else if (method !== "GET") reply = { status: 200, body: {} };
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  }
}));
const downloads = vi.hoisted(() => [] as Array<{ name: string; blob: Blob }>);
vi.mock("../../../lib/downloadFile", () => ({ downloadBlobFile: (blob: Blob, name: string) => downloads.push({ name, blob }) }));
const pdf = vi.hoisted(() => ({ calls: [] as Array<{ table: unknown; opts: { organizationName: string | null; exportedAt: Date } }> }));
vi.mock("../../../lib/yieldEntries/weeklyKgByVarietyPdf", () => ({
  buildWeeklyKgPdf: (table: unknown, opts: { organizationName: string | null; exportedAt: Date }) => {
    pdf.calls.push({ table, opts });
    return { output: () => new Blob(["%PDF"], { type: "application/pdf" }) };
  }
}));

import { WeeklyKgByVarietyCard } from "../WeeklyKgByVarietyCard";
import { KgEntriesTab } from "../../KgEntriesTab";
import { buildWeeklyKgTable, displayMatrix, tableHeader, weeklyKgCsv, type WeeklyKgByVarietySource } from "../../../lib/yieldEntries/weeklyKgByVariety";

const S2026: WeeklyKgByVarietySource = {
  year: 2026,
  years: [2026, 2025],
  entryCount: 5,
  varieties: [
    { id: "v-b", name: "Silverstone", status: "active" },
    { id: "v-a", name: "Cadalora", status: "active" },
    { id: "v-old", name: "Levente", status: "inactive" }
  ],
  entries: [
    { variety_id: "v-a", week: 30, total_kg: 1000.25 },
    { variety_id: "v-a", week: 30, total_kg: 500.5 },
    { variety_id: "v-b", week: 30, total_kg: 0 },
    { variety_id: "v-a", week: 33, total_kg: 12345.678 },
    { variety_id: "v-old", week: 33, total_kg: 40 }
  ]
};
const S2025: WeeklyKgByVarietySource = {
  year: 2025,
  years: [2026, 2025],
  entryCount: 1,
  varieties: [{ id: "v-old", name: "Levente", status: "inactive" }],
  entries: [{ variety_id: "v-old", week: 50, total_kg: 7 }]
};
const ok = (body: WeeklyKgByVarietySource) => () => ({ status: 200, body });

beforeEach(() => {
  server.calls.length = 0;
  server.weekly = { latest: ok(S2026), "2026": ok(S2026), "2025": ok(S2025) };
  downloads.length = 0;
  pdf.calls.length = 0;
});
afterEach(() => vi.clearAllMocks());

const card = () => screen.getByRole("region", { name: "Weekly kg by Variety" });
const tableRegion = () => within(card()).getByRole("region", { name: /^Weekly kg by variety, \d{4}$/ });
function tableText(): string[][] {
  return Array.from(tableRegion().querySelectorAll("tr")).map((tr) => Array.from(tr.children).map((c) => (c.textContent ?? "").replace(/Inactive$/, " (inactive)")));
}
const weeklyCalls = () => server.calls.filter((c) => c.path.startsWith("/api/yield-entries/weekly-by-variety"));
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("Weekly kg by Variety card", () => {
  it("loads the latest year and shows weeks down, varieties across, totals, — and 0.0", async () => {
    render(<WeeklyKgByVarietyCard refreshKey={0} />);
    expect(within(card()).getByRole("status")).toHaveTextContent("Loading weekly kg by variety…");
    await within(card()).findByRole("table");
    expect(weeklyCalls()[0].path).toBe("/api/yield-entries/weekly-by-variety");
    expect(within(card()).getByLabelText("Year")).toHaveValue("2026");
    expect(within(within(card()).getByLabelText("Year")).getAllByRole("option").map((o) => o.textContent)).toEqual(["2026", "2025"]);

    const table = buildWeeklyKgTable(S2026)!;
    const { body, foot } = displayMatrix(table);
    expect(tableText()).toEqual([tableHeader(table), ...body, foot]);
    expect(tableText()[1]).toEqual(["Week 30", "1,500.8", "—", "0.0", "1,500.8"]);
    expect(tableText()[2]).toEqual(["Week 31", "—", "—", "—", "—"]);
    expect(tableText()[tableText().length - 1]).toEqual(["Season total", "13,846.4", "40.0", "0.0", "13,886.4"]);
    // Row and column headers for assistive tech, and the inactive variety is marked.
    expect(within(tableRegion()).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["Week 30", "Week 31", "Week 32", "Week 33", "Season total"]);
    expect(within(tableRegion()).getByRole("columnheader", { name: /Levente/ })).toHaveTextContent("LeventeInactive");
  });

  it("switches year, separating each year's entries", async () => {
    const user = userEvent.setup();
    render(<WeeklyKgByVarietyCard refreshKey={0} />);
    await within(card()).findByRole("table");
    await user.selectOptions(within(card()).getByLabelText("Year"), "2025");
    await waitFor(() => expect(tableText()[0]).toEqual(["Week", "Levente (inactive)", "Weekly total"]));
    expect(weeklyCalls().map((c) => c.path)).toEqual(["/api/yield-entries/weekly-by-variety", "/api/yield-entries/weekly-by-variety?year=2025"]);
    expect(tableText().slice(1)).toEqual([
      ["Week 50", "7.0", "7.0"],
      ["Season total", "7.0", "7.0"]
    ]);
  });

  it("exports the full table as CSV and PDF, from the same table the card shows", async () => {
    const user = userEvent.setup();
    render(<WeeklyKgByVarietyCard refreshKey={0} />);
    await within(card()).findByRole("table");
    const exportButton = within(card()).getByRole("button", { name: "Export" });
    expect(exportButton).toHaveAttribute("aria-haspopup", "menu");

    await user.click(exportButton);
    await user.click(within(card()).getByRole("menuitem", { name: "CSV" }));
    expect(downloads[0].name).toBe("weekly-kg-by-variety-2026.csv");
    expect(downloads[0].blob.type).toBe("text/csv;charset=utf-8");
    const table = buildWeeklyKgTable(S2026)!;
    const csv = await readBlob(downloads[0].blob);
    expect(csv.replace(/^\uFEFF/, "")).toBe(weeklyKgCsv(table).replace(/^\uFEFF/, ""));
    // Same rows and columns as the card.
    const csvRows = csv.replace(/^\uFEFF/, "").trim().split("\r\n").map((l) => l.split(","));
    expect(csvRows.map((r) => r.length)).toEqual(tableText().map((r) => r.length));
    expect(csvRows.map((r) => r[0])).toEqual(["Week", "30", "31", "32", "33", "Season total"]);

    await user.click(exportButton);
    await user.click(within(card()).getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(downloads[1].name).toBe("weekly-kg-by-variety-2026.pdf");
    expect(pdf.calls[0].table).toEqual(table);
    expect(pdf.calls[0].opts.organizationName).toBe("First Light Greenhouses");
    // Exports read nothing more from the server.
    expect(weeklyCalls()).toHaveLength(1);
  });

  it("the menu closes on Escape and returns focus to Export", async () => {
    const user = userEvent.setup();
    render(<WeeklyKgByVarietyCard refreshKey={0} />);
    await within(card()).findByRole("table");
    const exportButton = within(card()).getByRole("button", { name: "Export" });
    await user.click(exportButton);
    expect(exportButton).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(within(card()).queryByRole("menu")).toBeNull();
    expect(exportButton).toHaveFocus();
  });

  it("shows an empty state and disables Export when there are no entries", async () => {
    server.weekly.latest = ok({ year: null, years: [], entryCount: 0, varieties: [], entries: [] });
    render(<WeeklyKgByVarietyCard refreshKey={0} />);
    expect(await within(card()).findByText("No yield entries yet.")).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "Export" })).toBeDisabled();
    expect(within(card()).queryByRole("table")).toBeNull();
  });

  it("on an error hides every total, offers Retry, and disables Export", async () => {
    const user = userEvent.setup();
    server.weekly.latest = () => ({ status: 500, body: { message: "Failed to load weekly kg by variety." } });
    render(<WeeklyKgByVarietyCard refreshKey={0} />);
    const alert = await within(card()).findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load weekly kg by variety. Totals are hidden until the full year loads.");
    expect(within(card()).queryByRole("table")).toBeNull();
    expect(within(card()).getByRole("button", { name: "Export" })).toBeDisabled();
    server.weekly.latest = ok(S2026);
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(card()).findByRole("table")).toBeInTheDocument();
  });

  it("an unexpected response shows the error instead of breaking the Kg Entries tab", async () => {
    server.weekly.latest = () => ({ status: 200, body: [] });
    render(<WeeklyKgByVarietyCard refreshKey={0} />);
    expect(await within(card()).findByRole("alert")).toHaveTextContent("Weekly kg by variety came back incomplete. Totals are hidden until the full year loads.");
    expect(within(card()).queryByRole("table")).toBeNull();
  });

  it("a failed refresh replaces the old table with the error rather than showing stale totals", async () => {
    const view = render(<WeeklyKgByVarietyCard refreshKey={0} />);
    await within(card()).findByRole("table");
    server.weekly["2026"] = () => ({ status: 500, body: { message: "Failed to load weekly kg by variety." } });
    server.weekly.latest = server.weekly["2026"];
    view.rerender(<WeeklyKgByVarietyCard refreshKey={1} />);
    await within(card()).findByRole("alert");
    expect(within(card()).queryByRole("table")).toBeNull();
  });
});

describe("Weekly kg by Variety in the Kg Entries tab", () => {
  it("sits below Recent Entries and reloads after an entry is saved", async () => {
    const user = userEvent.setup();
    render(<KgEntriesTab />);
    await screen.findByRole("region", { name: "Weekly kg by Variety" });
    await within(card()).findByRole("table");
    const recent = screen.getByRole("heading", { name: "Recent Entries" }).closest(".coming-soon-card")!;
    expect(recent.compareDocumentPosition(card()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recent.nextElementSibling).toBe(card());

    const before = weeklyCalls().length;
    server.weekly.latest = ok({ ...S2026, entryCount: 6, entries: [...S2026.entries, { variety_id: "v-b", week: 34, total_kg: 5 }] });
    server.weekly["2026"] = server.weekly.latest;
    await user.click(await screen.findByRole("button", { name: "Enter Kg Manually" }));
    const dialog = await screen.findByRole("dialog", { name: "Enter Kg" });
    await user.clear(within(dialog).getByLabelText("Small (kg)"));
    await user.type(within(dialog).getByLabelText("Small (kg)"), "5");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(weeklyCalls().length).toBeGreaterThan(before));
    await waitFor(() => expect(tableText().map((r) => r[0])).toContain("Week 34"));
    // Still the selected year (2026): the refresh keeps it.
    expect(weeklyCalls()[weeklyCalls().length - 1].path).toMatch(/weekly-by-variety(\?year=2026)?$/);
  });
});

describe("Weekly kg by Variety styles", () => {
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: string) => css.match(new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))![1];
  it("scrolls the table inside the card, keeps the week column and header row in view, and lets headers wrap", () => {
    expect(rule(".weekly-kg-variety-scroll")).toMatch(/overflow:\s*auto/);
    expect(rule(".weekly-kg-variety-table .weekly-kg-week")).toMatch(/position:\s*sticky;[\s\S]*left:\s*0/);
    expect(rule(".weekly-kg-variety-table thead th")).toMatch(/position:\s*sticky;[\s\S]*top:\s*0/);
    expect(rule(".weekly-kg-variety-table thead th")).toMatch(/white-space:\s*normal/);
    expect(rule(".weekly-kg-variety-card")).toMatch(/min-width:\s*0/);
  });
});
