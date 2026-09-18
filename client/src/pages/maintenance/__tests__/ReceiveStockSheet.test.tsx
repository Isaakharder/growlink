import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const postInventoryTransaction = vi.fn();
vi.mock("../api", () => ({ postInventoryTransaction: (...a: unknown[]) => postInventoryTransaction(...a) }));

import { ReceiveStockSheet } from "../ReceiveStockSheet";
import { InventoryItemRow } from "../types";

const ITEM = {
  id: "item-1", name: "Drip Emitters", quantity_on_hand: 10, unit_of_measure: "each", unit_of_measure_custom_label: null
} as InventoryItemRow;

describe("ReceiveStockSheet", () => {
  afterEach(() => vi.clearAllMocks());

  it("requires an explicit confirmation step before applying the transaction", async () => {
    render(<ReceiveStockSheet item={ITEM} onClose={vi.fn()} onApplied={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Quantity received/i), "25");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Not yet applied -- still on the confirmation screen.
    expect(postInventoryTransaction).not.toHaveBeenCalled();
    expect(screen.getByText(/New quantity will be 35/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Confirm Receipt" }));
    expect(postInventoryTransaction).toHaveBeenCalledWith("item-1", {
      transaction_type: "receive", quantity: 25, reason: null, request_id: expect.any(String)
    });
  });

  it("rejects a non-integer quantity for a discrete (each) unit", async () => {
    render(<ReceiveStockSheet item={ITEM} onClose={vi.fn()} onApplied={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Quantity received/i), "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/enter a whole number/i)).toBeInTheDocument();
    expect(postInventoryTransaction).not.toHaveBeenCalled();
  });

  it("does not permit a second submission while a receipt is in flight (double-tap protection)", async () => {
    let resolveTransaction: (value: unknown) => void = () => {};
    postInventoryTransaction.mockReturnValue(new Promise((resolve) => { resolveTransaction = resolve; }));

    render(<ReceiveStockSheet item={ITEM} onClose={vi.fn()} onApplied={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Quantity received/i), "5");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const confirmButton = screen.getByRole("button", { name: /Confirm Receipt/ });
    await userEvent.click(confirmButton);

    expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
    resolveTransaction({ item: ITEM });
    expect(postInventoryTransaction).toHaveBeenCalledTimes(1);
  });
});
