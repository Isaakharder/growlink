import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const postInventoryTransaction = vi.fn();
vi.mock("../api", () => ({ postInventoryTransaction: (...a: unknown[]) => postInventoryTransaction(...a) }));

import { AdjustStockSheet } from "../AdjustStockSheet";
import { InventoryItemRow } from "../types";

const ITEM = {
  id: "item-1", name: "Drip Emitters", quantity_on_hand: 10, unit_of_measure: "each", unit_of_measure_custom_label: null
} as InventoryItemRow;

describe("AdjustStockSheet", () => {
  afterEach(() => vi.clearAllMocks());

  it("requires a reason for a positive (add) adjustment and does not submit without one", async () => {
    render(<AdjustStockSheet item={ITEM} onClose={vi.fn()} onApplied={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.type(screen.getByLabelText(/Quantity/i), "5");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/a reason is required/i)).toBeInTheDocument();
    expect(postInventoryTransaction).not.toHaveBeenCalled();
  });

  it("requires a reason for a negative (remove) adjustment, applies it after confirmation", async () => {
    postInventoryTransaction.mockResolvedValue({ item: { ...ITEM, quantity_on_hand: 7 } });
    const onApplied = vi.fn();
    render(<AdjustStockSheet item={ITEM} onClose={vi.fn()} onApplied={onApplied} />);

    // "Remove" is the default direction.
    await userEvent.type(screen.getByLabelText(/Quantity/i), "3");
    await userEvent.type(screen.getByLabelText(/Reason/i), "damaged in transit");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText(/New quantity will be 7/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm Adjustment" }));

    expect(postInventoryTransaction).toHaveBeenCalledWith("item-1", {
      transaction_type: "remove", quantity: 3, reason: "damaged in transit", request_id: expect.any(String)
    });
    expect(onApplied).toHaveBeenCalled();
  });

  it("blocks removing more than the currently known on-hand quantity client-side, before hitting the server", async () => {
    render(<AdjustStockSheet item={ITEM} onClose={vi.fn()} onApplied={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Quantity/i), "999");
    await userEvent.type(screen.getByLabelText(/Reason/i), "count correction");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/cannot remove more than the current quantity/i)).toBeInTheDocument();
    expect(postInventoryTransaction).not.toHaveBeenCalled();
  });

  it("surfaces the server's negative-stock rejection message and preserves the entered reason", async () => {
    postInventoryTransaction.mockRejectedValue(
      new Error("This would result in a negative quantity (currently 10, change -3).")
    );
    render(<AdjustStockSheet item={ITEM} onClose={vi.fn()} onApplied={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/Quantity/i), "3");
    await userEvent.type(screen.getByLabelText(/Reason/i), "count correction");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm Adjustment" }));

    expect(await screen.findByText(/negative quantity/)).toBeInTheDocument();
    // Back to the form preserves what was typed.
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText(/Reason/i) as HTMLInputElement).value).toBe("count correction");
  });
});
