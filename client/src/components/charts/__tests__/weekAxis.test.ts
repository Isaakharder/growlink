import { describe, expect, it } from "vitest";
import { formatWeekAxisTick } from "../weekAxis";

describe("formatWeekAxisTick", () => {
  it("keeps only the week number of a weekly label", () => {
    expect(formatWeekAxisTick("W18 2026")).toBe("W18");
    expect(formatWeekAxisTick("W32 2026")).toBe("W32");
    expect(formatWeekAxisTick("W1 2027")).toBe("W1");
    expect(formatWeekAxisTick("W52 2025")).toBe("W52");
  });

  it("never leaves a four-digit year in the tick", () => {
    for (let week = 1; week <= 53; week += 1) expect(formatWeekAxisTick(`W${week} 2026`)).not.toMatch(/\d{4}/);
  });

  it("returns anything that isn't a W<week> <year> label unchanged", () => {
    for (const other of ["2026-09-26", "Sep 26", "W18", "Week 18 2026", "", 42]) expect(formatWeekAxisTick(other)).toBe(String(other));
  });
});
