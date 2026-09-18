import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const listInventoryItems = vi.fn();
const createRestockRequest = vi.fn();
const getRestockRequest = vi.fn();
const receiveRestockLine = vi.fn();
const markRestockRequestOrdered = vi.fn();
const cancelRestockRequest = vi.fn();

vi.mock("../api", () => ({
  listInventoryItems: (...a: unknown[]) => listInventoryItems(...a),
  createRestockRequest: (...a: unknown[]) => createRestockRequest(...a),
  getRestockRequest: (...a: unknown[]) => getRestockRequest(...a),
  receiveRestockLine: (...a: unknown[]) => receiveRestockLine(...a),
  markRestockRequestOrdered: (...a: unknown[]) => markRestockRequestOrdered(...a),
  cancelRestockRequest: (...a: unknown[]) => cancelRestockRequest(...a)
}));

import { RestockRequestSheet } from "../RestockRequestSheet";
import { RestockRequestDetailSheet } from "../RestockRequestDetailSheet";
import { InventoryItemRow, RestockRequestDetail } from "../types";

const PART = {
  id: "item-1", organization_id: "org-1", name: "Drip Emitters", part_number: "DE-100", part_type_id: null, part_type: null,
  location_id: "l1", location: { id: "l1", name: "Bay A" }, quantity_on_hand: 2, unit_of_measure: "each",
  unit_of_measure_custom_label: null, minimum_quantity: 10, suggested_reorder_quantity: 50, supplier: null,
  supplier_part_number: null, cost: null, notes: null, is_active: true, created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z", stock_status: "low_stock"
} satisfies InventoryItemRow;

describe("RestockRequestSheet (create)", () => {
  afterEach(() => vi.clearAllMocks());

  it("pre-fills a suggested quantity for a low-stock part and submits it as a line", async () => {
    listInventoryItems.mockResolvedValue([PART]);
    const request = { id: "req-1" } as RestockRequestDetail;
    createRestockRequest.mockResolvedValue(request);
    const onCreated = vi.fn();

    render(<RestockRequestSheet onClose={vi.fn()} onCreated={onCreated} />);
    await screen.findByText("Drip Emitters");

    const qtyInput = screen.getByPlaceholderText("Qty") as HTMLInputElement;
    expect(qtyInput.value).toBe("50");

    await userEvent.click(screen.getByRole("button", { name: /Review Request \(1 part\)/ }));
    await userEvent.click(screen.getByRole("button", { name: "Submit Request" }));

    expect(createRestockRequest).toHaveBeenCalledWith({
      lines: [{ item_id: "item-1", requested_quantity: 50, notes: null }],
      notes: null
    });
    expect(onCreated).toHaveBeenCalledWith(request);
  });

  it("blocks submission when nothing has a quantity entered", async () => {
    listInventoryItems.mockResolvedValue([{ ...PART, stock_status: "in_stock", minimum_quantity: null, suggested_reorder_quantity: null }]);
    render(<RestockRequestSheet onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByText("Drip Emitters");

    await userEvent.click(screen.getByRole("button", { name: /Review Request \(0 parts\)/ }));
    expect(await screen.findByText(/enter a quantity for at least one part/i)).toBeInTheDocument();
    expect(createRestockRequest).not.toHaveBeenCalled();
  });
});

describe("RestockRequestDetailSheet (receive)", () => {
  afterEach(() => vi.clearAllMocks());

  const DETAIL: RestockRequestDetail = {
    id: "req-1", organization_id: "org-1", status: "ordered", notes: null, requested_by: "u1",
    requested_by_name_snapshot: "Jamie", ordered_at: "2026-09-01T00:00:00Z", cancelled_at: null, cancelled_by: null,
    cancelled_reason: null, completed_at: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    lines: [
      {
        id: "line-1", organization_id: "org-1", request_id: "req-1", item_id: "item-1", item_name_snapshot: "Drip Emitters",
        unit_snapshot: "each", requested_quantity: 50, received_quantity: 0, notes: null, created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z", item: { id: "item-1", name: "Drip Emitters", part_number: "DE-100" }
      }
    ]
  };

  it("partially receives a line without exceeding the remaining quantity", async () => {
    getRestockRequest.mockResolvedValue(DETAIL);
    receiveRestockLine.mockResolvedValue({ line: { ...DETAIL.lines[0], received_quantity: 20 }, request_status: "partially_received" });
    const onChanged = vi.fn();

    render(<RestockRequestDetailSheet requestId="req-1" canAct onClose={vi.fn()} onChanged={onChanged} />);
    await screen.findByText("Drip Emitters");

    const qtyInput = screen.getByDisplayValue("50");
    await userEvent.clear(qtyInput);
    await userEvent.type(qtyInput, "20");
    await userEvent.click(screen.getByRole("button", { name: "Receive" }));

    expect(receiveRestockLine).toHaveBeenCalledWith("req-1", "line-1", { receive_quantity: 20, request_id: expect.any(String) });
    expect(onChanged).toHaveBeenCalled();
  });

  it("blocks receiving more than what remains on the line, client-side", async () => {
    getRestockRequest.mockResolvedValue(DETAIL);
    render(<RestockRequestDetailSheet requestId="req-1" canAct onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText("Drip Emitters");

    const qtyInput = screen.getByDisplayValue("50");
    await userEvent.clear(qtyInput);
    await userEvent.type(qtyInput, "999");
    await userEvent.click(screen.getByRole("button", { name: "Receive" }));

    expect(await screen.findByText(/only 50 each remains/i)).toBeInTheDocument();
    expect(receiveRestockLine).not.toHaveBeenCalled();
  });
});
