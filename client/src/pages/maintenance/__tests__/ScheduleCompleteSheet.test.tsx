import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const getSchedule = vi.fn();
const completeSchedule = vi.fn();
vi.mock("../api", () => ({
  getSchedule: (...a: unknown[]) => getSchedule(...a),
  completeSchedule: (...a: unknown[]) => completeSchedule(...a)
}));

import { ScheduleCompleteSheet } from "../ScheduleCompleteSheet";

const SCHEDULE = {
  id: "sch-1", name: "Change Oil", instructions: "Drain and refill", recurrence_type: "monthly", recurrence_interval: 1,
  next_due_date: "2026-09-10",
  checklist_items: [
    { id: "item-1", label: "Drain old oil", sort_order: 0 },
    { id: "item-2", label: "Replace filter", sort_order: 1 }
  ]
};

describe("ScheduleCompleteSheet", () => {
  afterEach(() => vi.clearAllMocks());

  it("loads the schedule's checklist and submits checked items with notes", async () => {
    getSchedule.mockResolvedValue(SCHEDULE);
    completeSchedule.mockResolvedValue({ id: "completion-1" });
    const onCompleted = vi.fn();

    render(<ScheduleCompleteSheet scheduleId="sch-1" onClose={vi.fn()} onCompleted={onCompleted} />);

    expect(await screen.findByText("Change Oil")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Drain old oil"));
    await userEvent.type(screen.getByLabelText(/completion notes/i), "All good");
    await userEvent.click(screen.getByRole("button", { name: "Mark Complete" }));

    expect(completeSchedule).toHaveBeenCalledWith("sch-1", {
      completion_request_id: expect.any(String),
      notes: "All good",
      checklist_responses: [
        { checklist_item_id: "item-1", checked: true },
        { checklist_item_id: "item-2", checked: false }
      ]
    });
    expect(onCompleted).toHaveBeenCalledWith({ id: "completion-1" });
  });

  it("reuses the same completion_request_id across a retry after a failed submission (idempotency)", async () => {
    getSchedule.mockResolvedValue(SCHEDULE);
    completeSchedule.mockRejectedValueOnce(new Error("Network error")).mockResolvedValueOnce({ id: "completion-1" });

    render(<ScheduleCompleteSheet scheduleId="sch-1" onClose={vi.fn()} onCompleted={vi.fn()} />);
    await screen.findByText("Change Oil");

    await userEvent.click(screen.getByRole("button", { name: "Mark Complete" }));
    expect(await screen.findByText("Network error")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mark Complete" }));

    const firstRequestId = completeSchedule.mock.calls[0][1].completion_request_id;
    const secondRequestId = completeSchedule.mock.calls[1][1].completion_request_id;
    expect(secondRequestId).toBe(firstRequestId);
  });

  it("shows a load error when the schedule fails to load", async () => {
    getSchedule.mockRejectedValue(new Error("Failed to load schedule."));
    render(<ScheduleCompleteSheet scheduleId="sch-1" onClose={vi.fn()} onCompleted={vi.fn()} />);

    expect(await screen.findByText("Failed to load schedule.")).toBeInTheDocument();
  });
});
