import { describe, expect, it } from "vitest";
import { isoWeekOf, isoWeekRangeLabel, isoWeeksInYear, shiftIsoWeek } from "../isoWeek";

describe("ISO weeks (UTC, Monday start)", () => {
  it("finds the ISO week and year, including dates that belong to the neighbouring ISO year", () => {
    expect(isoWeekOf(new Date(Date.UTC(2026, 10, 16)))).toEqual({ isoYear: 2026, isoWeek: 47 });
    expect(isoWeekOf(new Date(Date.UTC(2025, 11, 29)))).toEqual({ isoYear: 2026, isoWeek: 1 });
    expect(isoWeekOf(new Date(Date.UTC(2027, 0, 3)))).toEqual({ isoYear: 2026, isoWeek: 53 });
  });

  it("knows 52- and 53-week years and steps across them", () => {
    expect([isoWeeksInYear(2025), isoWeeksInYear(2026), isoWeeksInYear(2020)]).toEqual([52, 53, 53]);
    expect(shiftIsoWeek(2026, 53, 1)).toEqual({ isoYear: 2027, isoWeek: 1 });
    expect(shiftIsoWeek(2026, 1, -1)).toEqual({ isoYear: 2025, isoWeek: 52 });
  });

  it("labels the week's Monday to Sunday without depending on the locale", () => {
    expect(isoWeekRangeLabel(2026, 47)).toBe("Mon 16 Nov – Sun 22 Nov 2026");
    expect(isoWeekRangeLabel(2026, 53)).toBe("Mon 28 Dec – Sun 3 Jan 2027");
  });
});
