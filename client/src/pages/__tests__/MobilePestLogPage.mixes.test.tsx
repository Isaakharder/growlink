// Mobile Pest Log — mixes beyond the plan, actual amounts, leftovers, rows
// across two tanks, corrections and retries, against an in-memory server
// that follows the same rules as POST /pest/todos/:id/mixes.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMixes, planFromTodo } from "../../lib/pestMixSummary";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("../../hooks/useOnlineStatus", () => ({ useOnlineStatus: () => ({ isOnline: true }) }));
vi.mock("../../services/offlineQueue", () => ({ enqueue: vi.fn() }));
vi.mock("../../contexts/MembershipContext", () => ({ useMembership: () => ({ role: "owner", permissions: {} }) }));

import { MobilePestLogPage } from "../MobilePestLogPage";

const CHEM = "chem-1";
const PLAN = {
  type: "spray", method: "wanjet", rate_unit: "ml_per_acre", rate_value: 1000,
  total_volume_l: 9300, total_chemical_ml: 4092, tank_volume_l: 600, tank_count: 16,
  chem_per_liter_ml: 0.44, chem_per_full_tank_ml: 264, final_tank_volume_l: 300,
  chem_for_final_tank_ml: 132, is_last_full: false
};

type Mix = Record<string, any>;
let todo: Record<string, any>;
let mixes: Mix[];
let revisions: Mix[];
let posts: Array<Record<string, any>>;
let patches: Array<Record<string, any>>;
let failNextPost: boolean;

function setup(opts: { rows: number; doneRows?: number; mixesMade?: number }) {
  const rows = Array.from({ length: opts.rows }, (_, i) => {
    const done = i < (opts.doneRows ?? 0);
    const m = Math.min(Math.floor(i / 2) + 1, opts.mixesMade ?? 1);
    return { rowId: `r${i + 1}`, rowNumber: i + 1, rowLengthM: 50, completed: done, completedAt: done ? "2026-11-27T08:00:00Z" : null, completedByMixNumber: done ? m : null, mixNumbers: done ? [m] : [] };
  });
  todo = {
    id: "todo-1", type: "spray", status: "in_progress", application_date: "2026-11-27", chemical_id: CHEM,
    chemical_snapshot: { id: CHEM, name: "Kontos", rate_unit: "ml_per_acre", rate_value: 1000 },
    target_snapshot: { group_ids: ["g1"], group_names: ["Phase 1"] }, sprayer_snapshot: { name: "Wanjet" }, tank_snapshot: {},
    calculation_snapshot: PLAN, instructions: null, created_at: "2026-11-26T08:00:00Z", completed_at: null,
    progress_snapshot: { phases: [{ phaseId: "g1", phaseName: "Phase 1", completed: false, completedAt: null, rows }] }
  };
  mixes = Array.from({ length: opts.mixesMade ?? 0 }, (_, i) => ({
    id: `m${i + 1}`, client_key: `k${i + 1}`, mix_number: i + 1, status: i + 1 === opts.mixesMade ? "active" : "completed",
    is_extra: i + 1 > 16, planned_water_l: i + 1 === 16 ? 300 : 600, planned_chemicals: [],
    water_l: 600, chemicals: [{ chemical_id: CHEM, name: "Kontos", amount: 264, unit: "ml" }], leftover_l: 0,
    started_at: "2026-11-27T08:00:00Z", ended_at: null, revision: 1
  }));
  revisions = mixes.map((m) => ({ mix_id: m.id, revision: 1, action: "created", before: null, after: { ...m }, reason: null, changed_at: m.started_at }));
  posts = [];
  patches = [];
  failNextPost = false;
}

const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });

function fakeServer(path: string, init?: { method?: string; body?: string }) {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body) : null;
  if (path === "/api/pest/todos?status=active") return json([todo]);
  if (path === "/api/pest/todos?status=completed") return json([]);
  if (path.endsWith("/mixes") && method === "GET") return json({ available: true, mixes, revisions });
  if (path.endsWith("/mixes") && method === "POST") {
    posts.push(body);
    if (failNextPost) {
      failNextPost = false;
      // The server saved it, but the response never arrived.
      applyMix(body);
      return Promise.reject(new TypeError("Network request failed"));
    }
    return json(applyMix(body), 201);
  }
  if (path.endsWith("/progress")) {
    patches.push(body);
    todo.progress_snapshot = body.progress_snapshot;
    return json({ id: todo.id });
  }
  if (path.endsWith("/complete")) {
    for (const m of mixes) m.status = "completed";
    const rows = todo.progress_snapshot.phases.flatMap((p: any) => p.rows);
    const summary = summarizeMixes(planFromTodo(todo), mixes as any, rows, { assumeClosed: true });
    todo.status = "completed";
    return json({ ok: true, todo: { id: todo.id }, mix_summary: summary });
  }
  return json({});
}

function applyMix(b: Record<string, any>) {
  const existing = mixes.find((m) => m.client_key === b.client_key);
  if (existing) {
    const before = { ...existing };
    Object.assign(existing, { water_l: b.water_l, chemicals: b.chemicals, leftover_l: b.leftover_l ?? existing.leftover_l, status: b.status ?? existing.status, revision: existing.revision + 1 });
    revisions.push({ mix_id: existing.id, revision: existing.revision, action: before.water_l !== b.water_l ? "corrected" : "leftover", before, after: { ...existing }, reason: b.reason ?? null, changed_at: "2026-11-27T09:00:00Z" });
    return { mix: existing, created: false, changed: true };
  }
  for (const m of mixes) if (m.status === "active") Object.assign(m, { status: "completed", leftover_l: b.previous_leftover_l ?? m.leftover_l });
  const m = { id: `m${b.mix_number}`, client_key: b.client_key, mix_number: b.mix_number, status: "active", is_extra: b.mix_number > 16,
    planned_water_l: 600, planned_chemicals: [], water_l: b.water_l, chemicals: b.chemicals, leftover_l: 0,
    started_at: "2026-11-27T09:00:00Z", ended_at: null, revision: 1 };
  mixes.push(m);
  revisions.push({ mix_id: m.id, revision: 1, action: "created", before: null, after: { ...m }, reason: null, changed_at: m.started_at });
  return { mix: m, created: true, changed: true };
}

async function openJob(user: ReturnType<typeof userEvent.setup>) {
  render(<MemoryRouter><MobilePestLogPage /></MemoryRouter>);
  await user.click(await screen.findByRole("button", { name: /Kontos/ }));
  await screen.findByTestId("mix-progress");
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(fakeServer);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("Mobile Pest Log mixes", () => {
  it("after all 16 planned mixes, Mix #17 can still be started with actual amounts and the previous tank's leftover", async () => {
    setup({ rows: 40, doneRows: 32, mixesMade: 16 });
    const user = userEvent.setup();
    await openJob(user);
    const card = screen.getByTestId("mix-progress");
    expect(within(card).getByText(/of 16 planned/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start Mix #17" }));
    const form = screen.getByTestId("mix-form");
    expect(within(form).getByText("Mix #17 — extra mix")).toBeInTheDocument();
    const water = within(form).getByLabelText("Water (L)") as HTMLInputElement;
    expect(water.value).toBe("600");
    expect((within(form).getByLabelText("Kontos (ml)") as HTMLInputElement).value).toBe("264");
    await user.clear(water);
    await user.type(water, "450");
    await user.clear(within(form).getByLabelText(/Left over in Mix #16/));
    await user.type(within(form).getByLabelText(/Left over in Mix #16/), "20");
    await user.click(within(form).getByRole("button", { name: "Save Mix #17" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ mix_number: 17, water_l: 450, previous_leftover_l: 20, chemicals: [{ chemical_id: CHEM, amount: 264, unit: "ml" }] });
    expect(await screen.findByText("+1 extra")).toBeInTheDocument();
    expect(screen.getByText("Mix #17")).toBeInTheDocument();
    // The plan baseline was never edited.
    expect(todo.calculation_snapshot).toEqual(PLAN);
  });

  it("a retry after a lost response reuses the same entry (no second mix)", async () => {
    setup({ rows: 4, mixesMade: 1 });
    const user = userEvent.setup();
    await openJob(user);
    await user.click(screen.getByRole("button", { name: "Start Mix #2" }));
    failNextPost = true;
    await user.click(screen.getByRole("button", { name: "Save Mix #2" }));
    expect(await screen.findByText(/retrying won't add a second mix/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Mix #2" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].client_key).toBe(posts[0].client_key);
  });

  it("a row finished on the next tank is linked to both", async () => {
    setup({ rows: 4, mixesMade: 1 });
    const user = userEvent.setup();
    await openJob(user);
    await user.click(screen.getByRole("button", { name: "Tank ran out mid-row" }));
    await user.selectOptions(screen.getByLabelText(/Row where Mix #1 ran out/), "r2");
    await user.click(screen.getByRole("button", { name: "Link row and start Mix #2" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].progress_snapshot.phases[0].rows[1]).toMatchObject({ completed: false, partial: true, mixNumbers: [1] });

    await user.click(within(screen.getByTestId("mix-form")).getByRole("button", { name: "Save Mix #2" }));
    await screen.findByText("Mix #2");
    await user.click(screen.getByRole("button", { name: /Row 2/ }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1].progress_snapshot.phases[0].rows[1]).toMatchObject({ completed: true, mixNumbers: [1, 2], completedByMixNumber: 2 });
    expect(await screen.findByText("Mix #1 → #2")).toBeInTheDocument();
  });

  it("correcting an entry needs a reason and keeps the original in the history", async () => {
    setup({ rows: 4, mixesMade: 2 });
    const user = userEvent.setup();
    await openJob(user);
    await user.click(screen.getByRole("button", { name: /Previous mixes/ }));
    await user.click(screen.getByRole("button", { name: "Correct Mix #1" }));
    const form = screen.getByTestId("mix-form");
    const water = within(form).getByLabelText("Water (L)");
    await user.clear(water);
    await user.type(water, "560");
    await user.click(within(form).getByRole("button", { name: "Save correction" }));
    expect(within(form).getByText(/Say why/)).toBeInTheDocument();
    expect(posts).toHaveLength(0);
    await user.type(within(form).getByLabelText("Reason for correction"), "Gauge read 560 L");
    await user.click(within(form).getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ client_key: "k1", water_l: 560, reason: "Gauge read 560 L" });
    expect(await screen.findByText("Corrected 1×")).toBeInTheDocument();
    expect(screen.getByText(/water 600 → 560 L/)).toBeInTheDocument();
  });

  it("finishing asks for the last tank's leftover, then shows planned vs actual", async () => {
    setup({ rows: 4, doneRows: 3, mixesMade: 2 });
    const user = userEvent.setup();
    await openJob(user);
    await user.click(screen.getByRole("button", { name: /Row 4/ }));
    const leftover = await screen.findByTestId("leftover-form");
    await user.clear(within(leftover).getByLabelText("Leftover (L)"));
    await user.type(within(leftover).getByLabelText("Leftover (L)"), "100");
    await user.click(within(leftover).getByRole("button", { name: "Save record" }));

    const result = await screen.findByTestId("planned-vs-actual");
    expect(posts.at(-1)).toMatchObject({ client_key: "k2", leftover_l: 100, status: "completed" });
    // 2 × 600 L mixed − 100 L leftover = 1,100 L applied against 9,300 L planned.
    expect(within(result).getByText(/Applied vs plan: −8,200 L \(−88\.2%\) under/)).toBeInTheDocument();
    expect(within(result).getByText(/Mixed vs plan: −8,100 L/)).toBeInTheDocument();
    expect(within(result).getByText("2 mixes made · 16 planned · 100 L left over")).toBeInTheDocument();
  });
});
