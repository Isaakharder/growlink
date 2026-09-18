import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const logEquipmentWork = vi.fn();
vi.mock("../api", () => ({ logEquipmentWork: (...a: unknown[]) => logEquipmentWork(...a) }));

import { WorkLogSheet } from "../WorkLogSheet";
import { EquipmentRow } from "../types";

const EQUIPMENT = {
  id: "eq-1", name: "Boom Sprayer", current_meter_reading: 100, meter_unit: "hours", meter_unit_custom_label: null
} as EquipmentRow;

describe("WorkLogSheet", () => {
  afterEach(() => vi.clearAllMocks());

  it("requires Work Performed and does not submit without it", async () => {
    render(<WorkLogSheet equipment={EQUIPMENT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Save Job" }));

    expect(await screen.findByText(/enter what work was performed/i)).toBeInTheDocument();
    expect(logEquipmentWork).not.toHaveBeenCalled();
  });

  it("saves work without a meter reading", async () => {
    const onSaved = vi.fn();
    logEquipmentWork.mockResolvedValue({ id: "wl-1", work_performed: "Inspected lift controls" });
    render(<WorkLogSheet equipment={EQUIPMENT} onClose={vi.fn()} onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText(/work performed/i), "Inspected lift controls");
    await userEvent.click(screen.getByRole("button", { name: "Save Job" }));

    expect(logEquipmentWork).toHaveBeenCalledWith(
      "eq-1",
      expect.objectContaining({ work_performed: "Inspected lift controls", meter_reading_value: null, notes: null })
    );
    expect(onSaved).toHaveBeenCalledWith({ id: "wl-1", work_performed: "Inspected lift controls" });
  });

  it("saves work together with a meter reading and notes, sending both in one call", async () => {
    logEquipmentWork.mockResolvedValue({ id: "wl-2" });
    render(<WorkLogSheet equipment={EQUIPMENT} onClose={vi.fn()} onSaved={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/work performed/i), "Replaced hydraulic hose");
    await userEvent.type(screen.getByLabelText(/new reading/i), "125");
    await userEvent.type(screen.getByLabelText(/notes/i), "Old hose was cracked");
    await userEvent.click(screen.getByRole("button", { name: "Save Job" }));

    expect(logEquipmentWork).toHaveBeenCalledWith(
      "eq-1",
      expect.objectContaining({ work_performed: "Replaced hydraulic hose", meter_reading_value: 125, notes: "Old hose was cracked" })
    );
  });

  it("defaults Date and Time to now and allows editing it to an earlier time", async () => {
    render(<WorkLogSheet equipment={EQUIPMENT} onClose={vi.fn()} onSaved={vi.fn()} />);
    const dateInput = screen.getByLabelText(/date and time/i) as HTMLInputElement;
    expect(dateInput.value).not.toBe("");

    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, "2026-01-01T08:00");
    logEquipmentWork.mockResolvedValue({ id: "wl-3" });

    await userEvent.type(screen.getByLabelText(/work performed/i), "Backdated job");
    await userEvent.click(screen.getByRole("button", { name: "Save Job" }));

    const sentPayload = logEquipmentWork.mock.calls[0][1];
    expect(new Date(sentPayload.performed_at).toISOString()).toBe(new Date("2026-01-01T08:00").toISOString());
  });

  it("Save Job cannot create duplicates from repeated taps: same request_id reused, only one call resolves while saving", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    logEquipmentWork.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    render(<WorkLogSheet equipment={EQUIPMENT} onClose={vi.fn()} onSaved={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/work performed/i), "Lubricated pivot points");
    const button = screen.getByRole("button", { name: "Save Job" });
    await userEvent.click(button);

    // Button is disabled while the first save is in flight — a second tap
    // cannot fire a second request.
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
    expect(logEquipmentWork).toHaveBeenCalledTimes(1);

    resolveFirst({ id: "wl-4" });
  });

  it("reuses the same request_id across a retry after a failed save (idempotency)", async () => {
    logEquipmentWork.mockRejectedValueOnce(new Error("Network error")).mockResolvedValueOnce({ id: "wl-5" });
    render(<WorkLogSheet equipment={EQUIPMENT} onClose={vi.fn()} onSaved={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/work performed/i), "Adjusted limit switch");
    await userEvent.click(screen.getByRole("button", { name: "Save Job" }));
    expect(await screen.findByText("Network error")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save Job" }));

    const firstRequestId = logEquipmentWork.mock.calls[0][1].request_id;
    const secondRequestId = logEquipmentWork.mock.calls[1][1].request_id;
    expect(secondRequestId).toBe(firstRequestId);
  });

  it("a failed save keeps the form open with the entered text intact (no partial/silent loss)", async () => {
    logEquipmentWork.mockRejectedValue(new Error("New reading (50) is lower than the current reading (100)."));
    render(<WorkLogSheet equipment={EQUIPMENT} onClose={vi.fn()} onSaved={vi.fn()} />);

    const workField = screen.getByLabelText(/work performed/i) as HTMLTextAreaElement;
    await userEvent.type(workField, "Attempted service");
    await userEvent.type(screen.getByLabelText(/new reading/i), "50");
    await userEvent.click(screen.getByRole("button", { name: "Save Job" }));

    expect(await screen.findByText(/lower than the current reading/i)).toBeInTheDocument();
    expect(workField.value).toBe("Attempted service");
    expect((screen.getByLabelText(/new reading/i) as HTMLInputElement).value).toBe("50");
  });

  it("rejects a negative meter reading client-side before calling the API", async () => {
    render(<WorkLogSheet equipment={EQUIPMENT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/work performed/i), "Some work");
    await userEvent.type(screen.getByLabelText(/new reading/i), "-5");
    await userEvent.click(screen.getByRole("button", { name: "Save Job" }));

    expect(await screen.findByText(/enter a valid reading value/i)).toBeInTheDocument();
    expect(logEquipmentWork).not.toHaveBeenCalled();
  });
});
