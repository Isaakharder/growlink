import { describe, expect, it } from "vitest";
import { describeHeaderOccurrences, findDuplicateGroupMismatches, ordinal, type ColumnAssignments, type MappingType } from "../csvVisualMapping";

// A real FlowMaster export header: a per-size WEIGHT/AVG/PCS group
// (columns 8-10) followed by a lot-total group (11-13).
const FLOWMASTER_HEADER = ["LOTNUMBER", "RUN", "VARIETY", "BEGINDT", "ENDDT", "MARKET", "SIZE1", "SIZE2", "WEIGHT", "AVG", "PCS", "WEIGHT", "AVG", "PCS "];

const assign = (entries: Array<[number, MappingType]>): ColumnAssignments => new Map(entries);

describe("describeHeaderOccurrences", () => {
  it("numbers repeated headers by position, ignoring case and surrounding whitespace", () => {
    const occ = describeHeaderOccurrences(FLOWMASTER_HEADER);
    expect(occ[8]).toEqual({ text: "WEIGHT", occurrence: 1, total: 2 });
    expect(occ[11]).toEqual({ text: "WEIGHT", occurrence: 2, total: 2 });
    expect(occ[10]).toEqual({ text: "PCS", occurrence: 1, total: 2 });
    expect(occ[13]).toEqual({ text: "PCS", occurrence: 2, total: 2 });
    expect(occ[0]).toEqual({ text: "LOTNUMBER", occurrence: 1, total: 1 });
  });

  it("formats ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
  });
});

describe("findDuplicateGroupMismatches — positional WEIGHT/AVG/PCS rule", () => {
  it("flags AVG/PCS taken from the lot-total group while Size Weight uses the per-size group (the saved Latest Mapping layout)", () => {
    const messages = findDuplicateGroupMismatches(
      FLOWMASTER_HEADER,
      assign([
        [8, "size_weight_kg"],
        [12, "average_fruit_weight_g"],
        [13, "piece_count"]
      ])
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/Average Fruit Weight g uses the 2nd "AVG" column, but Size Weight kg uses the 1st "WEIGHT"/);
    expect(messages[1]).toMatch(/Piece Count uses the 2nd "PCS" column/);
  });

  it("accepts the intended first group", () => {
    expect(
      findDuplicateGroupMismatches(
        FLOWMASTER_HEADER,
        assign([
          [8, "size_weight_kg"],
          [9, "average_fruit_weight_g"],
          [10, "piece_count"]
        ])
      )
    ).toEqual([]);
  });

  it("does not apply when the headers are not repeated", () => {
    const header = ["Date", "Size", "Kg", "Avg g", "Pieces"];
    expect(
      findDuplicateGroupMismatches(
        header,
        assign([
          [2, "size_weight_kg"],
          [3, "average_fruit_weight_g"],
          [4, "piece_count"]
        ])
      )
    ).toEqual([]);
  });

  it("does nothing until Size Weight kg is mapped", () => {
    expect(findDuplicateGroupMismatches(FLOWMASTER_HEADER, assign([[13, "piece_count"]]))).toEqual([]);
  });
});
