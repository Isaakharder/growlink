import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const recordMeterReading = vi.fn();
vi.mock("../api", () => ({ recordMeterReading: (...a: unknown[]) => recordMeterReading(...a) }));

import { MeterReadingSheet } from "../MeterReadingSheet";
import { EquipmentRow } from "../types";

const EQUIPMENT = {
  id: "eq-1", name: "Boom Sprayer", current_meter_reading: 100, meter_unit: "hours", meter_unit_custom_label: null
} as EquipmentRow;

describe("MeterReadingSheet", () => {
  afterEach(() => vi.clearAllMocks());

  it("submits a valid reading and calls onRecorded", async () => {
    const onRecorded = vi.fn();
    recordMeterReading.mockResolvedValue({ id: "r1", value: 150 });
    render(<MeterReadingSheet equipment={EQUIPMENT} onClose={vi.fn()} onRecorded={onRecorded} />);

    await userEvent.type(screen.getByLabelText(/New reading/i), "150");
    await userEvent.click(screen.getByRole("button", { name: "Save Reading" }));

    expect(recordMeterReading).toHaveBeenCalledWith("eq-1", { value: 150, note: null, is_reset: false, reset_reason: null });
    expect(onRecorded).toHaveBeenCalled();
  });

  it("rejects a blank/invalid value client-side without calling the API, preserving nothing to lose", async () => {
    render(<MeterReadingSheet equipment={EQUIPMENT} onClose={vi.fn()} onRecorded={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Save Reading" }));

    expect(await screen.findByText(/enter a valid reading value/i)).toBeInTheDocument();
    expect(recordMeterReading).not.toHaveBeenCalled();
  });

  it("requires a reset reason when 'meter reset' is checked, and does not submit without one", async () => {
    render(<MeterReadingSheet equipment={EQUIPMENT} onClose={vi.fn()} onRecorded={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/New reading/i), "0");
    await userEvent.click(screen.getByLabelText(/this is a meter reset/i));
    await userEvent.click(screen.getByRole("button", { name: "Save Reading" }));

    expect(await screen.findByText(/a reason is required/i)).toBeInTheDocument();
    expect(recordMeterReading).not.toHaveBeenCalled();
  });

  it("keeps the entered value on screen (does not clear the form) when the API call fails", async () => {
    recordMeterReading.mockRejectedValue(new Error("New reading (90) is lower than the current reading (100)."));
    render(<MeterReadingSheet equipment={EQUIPMENT} onClose={vi.fn()} onRecorded={vi.fn()} />);

    const input = screen.getByLabelText(/New reading/i) as HTMLInputElement;
    await userEvent.type(input, "90");
    await userEvent.click(screen.getByRole("button", { name: "Save Reading" }));

    expect(await screen.findByText(/New reading \(90\) is lower/)).toBeInTheDocument();
    expect(input.value).toBe("90");
  });
});
