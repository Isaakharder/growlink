import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const getStockCountSession = vi.fn();
const saveStockCountLine = vi.fn();
const confirmStockCountSession = vi.fn();
const cancelStockCountSession = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getStockCountSession: (...a: unknown[]) => getStockCountSession(...a),
    saveStockCountLine: (...a: unknown[]) => saveStockCountLine(...a),
    confirmStockCountSession: (...a: unknown[]) => confirmStockCountSession(...a),
    cancelStockCountSession: (...a: unknown[]) => cancelStockCountSession(...a)
  };
});

import { StockCountSessionSheet } from "../StockCountSessionSheet";
import { StockCountSessionDetail } from "../types";

const SESSION: StockCountSessionDetail = {
  id: "session-1", organization_id: "org-1", location_id: "l1", location_name_snapshot: "Bay A", status: "draft",
  started_by: "u1", started_by_name_snapshot: "Jamie", started_at: "2026-09-01T00:00:00Z", confirmed_at: null,
  confirmed_by: null, cancelled_at: null, cancelled_by: null, cancelled_reason: null, created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  lines: [
    {
      id: "line-1", organization_id: "org-1", session_id: "session-1", item_id: "item-1", item_name_snapshot: "Drip Emitters",
      unit_snapshot: "each", expected_quantity: 10, expected_last_transaction_id: "tx-1", counted_quantity: null,
      counted_at: null, counted_by: null, notes: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
      variance: null
    }
  ]
};

describe("StockCountSessionSheet", () => {
  afterEach(() => vi.clearAllMocks());

  it("saves a counted quantity as progress when the input loses focus", async () => {
    getStockCountSession.mockResolvedValue(SESSION);
    saveStockCountLine.mockResolvedValue({ ...SESSION.lines[0], counted_quantity: 8 });

    render(<StockCountSessionSheet sessionId="session-1" onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText("Drip Emitters");

    const input = screen.getByRole("spinbutton");
    await userEvent.type(input, "8");
    await userEvent.tab();

    expect(saveStockCountLine).toHaveBeenCalledWith("session-1", "line-1", { counted_quantity: 8, notes: null });
    expect(await screen.findByText("Saved ✓")).toBeInTheDocument();
  });

  it("shows expected/counted/variance in the review step before confirming", async () => {
    getStockCountSession.mockResolvedValue({ ...SESSION, lines: [{ ...SESSION.lines[0], counted_quantity: 8, variance: -2 }] });
    render(<StockCountSessionSheet sessionId="session-1" onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText("Drip Emitters");

    await userEvent.click(screen.getByRole("button", { name: /Review & Submit/ }));

    expect(screen.getByRole("columnheader", { name: "Expected" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "10" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "8" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "-2" })).toBeInTheDocument();
  });

  it("confirming succeeds and reports the applied session upward", async () => {
    getStockCountSession.mockResolvedValue(SESSION);
    confirmStockCountSession.mockResolvedValue({ ok: true, session: { ...SESSION, status: "confirmed" } });
    const onChanged = vi.fn();
    const onClose = vi.fn();

    render(<StockCountSessionSheet sessionId="session-1" onClose={onClose} onChanged={onChanged} />);
    await screen.findByText("Drip Emitters");
    await userEvent.click(screen.getByRole("button", { name: /Review & Submit/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm Count" }));

    expect(confirmStockCountSession).toHaveBeenCalledWith("session-1");
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the conflict list and does NOT close the sheet when the server reports a stale count", async () => {
    getStockCountSession.mockResolvedValue(SESSION);
    confirmStockCountSession.mockResolvedValue({
      ok: false,
      conflict: true,
      message: "Some items changed since this count started. Review the conflicts and start a new count.",
      conflicts: [{ line_id: "line-1", reason: "inventory_changed_since_snapshot" }]
    });
    const onClose = vi.fn();

    render(<StockCountSessionSheet sessionId="session-1" onClose={onClose} onChanged={vi.fn()} />);
    await screen.findByText("Drip Emitters");
    await userEvent.click(screen.getByRole("button", { name: /Review & Submit/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm Count" }));

    expect(await screen.findByText(/some items changed since this count started/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
