import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Instrumentation: every apiFetch call is recorded, so a test can assert how
// many times a given endpoint was hit for one page load. This is the harness
// that measured the production request storm.
const calls: string[] = [];
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (path: string, options?: RequestInit) => {
    calls.push(path);
    return apiFetch(path, options);
  }
}));

import { CsvTemplateBuilderTab } from "../CsvTemplateBuilderTab";

const weeklyCardsCount = () => calls.filter((c) => c.includes("weekly-cards")).length;

const jsonOk = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });

const rateLimited = (retryAfterSeconds = 42) => ({
  ok: false,
  status: 429,
  headers: new Headers({ "retry-after": String(retryAfterSeconds) }),
  json: async () => ({
    message: "Too many requests for this operation. Please wait before retrying.",
    retryAfterSeconds,
    retryAt: new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
  })
});

const EMPTY = { cards: [], unmatched: [] };

function routeTo(handler: (path: string) => unknown) {
  apiFetch.mockImplementation((path: string) => Promise.resolve(handler(path)));
}

function renderTab() {
  return render(
    <MemoryRouter>
      <CsvTemplateBuilderTab />
    </MemoryRouter>
  );
}

const settle = () => new Promise((r) => setTimeout(r, 200));

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  routeTo((path) => (path.includes("weekly-cards") ? jsonOk(EMPTY) : jsonOk([])));
});

afterEach(() => vi.clearAllMocks());

describe("CsvTemplateBuilderTab — weekly-cards request volume", () => {
  it("issues exactly one weekly-cards request for a single page load", async () => {
    renderTab();
    await waitFor(() => expect(weeklyCardsCount()).toBe(1));
    await settle();
    expect(weeklyCardsCount()).toBe(1);
  });

  it("does not refetch when unrelated state re-renders the tab many times", async () => {
    renderTab();
    await waitFor(() => expect(weeklyCardsCount()).toBe(1));

    // Drive re-renders through the *saved templates* Refresh, which refetches
    // a different endpoint. Each click re-renders the whole tab; the pending
    // list must not piggy-back on any of them.
    const user = userEvent.setup();
    const section = screen.getByRole("heading", { name: /saved csv templates/i }).closest("div")!;
    const templatesRefresh = within(section).getByRole("button", { name: /^refresh$/i });
    for (let i = 0; i < 5; i++) await user.click(templatesRefresh);

    await settle();
    expect(calls.filter((c) => c.includes("csv-templates") && !c.includes("pending")).length)
      .toBeGreaterThan(1); // the re-render driver really did fire
    expect(weeklyCardsCount()).toBe(1);
  });

  it("exposes Refresh controls that are disabled while a request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    apiFetch.mockImplementation(async (path: string) => {
      if (path.includes("weekly-cards")) { await gate; return jsonOk(EMPTY); }
      return jsonOk([]);
    });

    renderTab();
    await waitFor(() => expect(weeklyCardsCount()).toBe(1));

    const refreshing = screen.getAllByRole("button", { name: /refreshing/i });
    expect(refreshing.length).toBeGreaterThan(0); // non-vacuous
    for (const b of refreshing) expect(b).toBeDisabled();

    release();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^refresh$/i })[0]).toBeEnabled());
    expect(weeklyCardsCount()).toBe(1);
  });

  // The behaviour the production console showed: repeated 429s. A 429 must
  // terminate the chain — no automatic retry, no backoff-free loop.
  it("does not retry automatically after a 429", async () => {
    routeTo((path) => (path.includes("weekly-cards") ? rateLimited() : jsonOk([])));
    renderTab();
    await waitFor(() => expect(weeklyCardsCount()).toBe(1));
    await settle();
    await settle();
    expect(weeklyCardsCount()).toBe(1);
  });

  it("surfaces Retry-After guidance instead of a bare error after a 429", async () => {
    routeTo((path) => (path.includes("weekly-cards") ? rateLimited(42) : jsonOk([])));
    renderTab();
    await waitFor(() => expect(weeklyCardsCount()).toBe(1));

    // The shared rate-limit notice, with its live countdown, rather than the
    // generic "Failed to load pending CSV imports" string.
    expect(await screen.findByText(/Too many requests for this operation/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/You can try again in \d+s\./)).toBeInTheDocument());
    expect(screen.getByText(/pending list below may be out of date/i)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load pending CSV imports/i)).not.toBeInTheDocument();
  });

  it("an explicit Refresh after load issues exactly one fresh request", async () => {
    renderTab();
    await waitFor(() => expect(weeklyCardsCount()).toBe(1));

    const user = userEvent.setup();
    const refresh = screen.getAllByRole("button", { name: /^refresh$/i })[0];
    expect(refresh).toBeEnabled();
    await user.click(refresh);

    await waitFor(() => expect(weeklyCardsCount()).toBe(2));
    await settle();
    expect(weeklyCardsCount()).toBe(2); // exactly one more, not a storm
  });

  it("aborts the in-flight request on unmount and never sets state afterwards", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let signal: AbortSignal | undefined;
    apiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.includes("weekly-cards")) {
        signal = options?.signal ?? undefined;
        await gate;
        return jsonOk(EMPTY);
      }
      return jsonOk([]);
    });

    const { unmount } = renderTab();
    await waitFor(() => expect(weeklyCardsCount()).toBe(1));
    expect(signal).toBeDefined();          // a signal is actually passed
    expect(signal!.aborted).toBe(false);

    unmount();
    expect(signal!.aborted).toBe(true);    // cancelled on unmount

    release();
    await settle();
    expect(weeklyCardsCount()).toBe(1);
    const warned = errorSpy.mock.calls.some((c) => String(c[0]).includes("unmounted component"));
    expect(warned).toBe(false);
    errorSpy.mockRestore();
  });
});
