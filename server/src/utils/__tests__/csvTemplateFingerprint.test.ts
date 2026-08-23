import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFingerprint, computeFingerprintHash, matchFingerprint } from "../csvTemplateFingerprint";

const FLOWMASTER_HEADER = [
  "LOTNUMBER", "RUN", "VARIETY", "BEGINDT", "ENDDT", "MARKET",
  "SIZE1", "SIZE2", "WEIGHT", "AVG", "PCS", "WEIGHT", "AVG", "PCS"
];

function gridWithHeader(header: string[], dataRows: string[][] = [["x"]]): string[][] {
  return [header, ...dataRows];
}

test("computeFingerprint normalizes header case/whitespace and preserves duplicate-header positions", () => {
  const grid = gridWithHeader([" lotnumber ", "Run", "variety", "BEGINDT", "MARKET", "size1", "weight", "avg", "pcs", "WEIGHT", "AVG", "PCS"]);
  const fp = computeFingerprint(grid, ",", 0);

  assert.equal(fp.headers[0], "LOTNUMBER");
  assert.equal(fp.headers[1], "RUN");
  // Both WEIGHT occurrences preserved at their own distinct positions.
  assert.equal(fp.headers[6], "WEIGHT");
  assert.equal(fp.headers[9], "WEIGHT");
  assert.equal(fp.columnCount, 12);
});

test("computeFingerprintHash is stable for identical structure and changes when structure changes", () => {
  const gridA = gridWithHeader(FLOWMASTER_HEADER);
  const gridB = gridWithHeader(FLOWMASTER_HEADER);
  const fpA = computeFingerprint(gridA, ",", 0);
  const fpB = computeFingerprint(gridB, ",", 0);
  assert.equal(computeFingerprintHash(fpA), computeFingerprintHash(fpB));

  const gridC = gridWithHeader([...FLOWMASTER_HEADER, "EXTRA"]);
  const fpC = computeFingerprint(gridC, ",", 0);
  assert.notEqual(computeFingerprintHash(fpA), computeFingerprintHash(fpC));
});

test("computeFingerprintHash is unaffected by data-row content (dates, varieties, lot numbers, weights)", () => {
  const gridJune = gridWithHeader(FLOWMASTER_HEADER, [
    ["2608170362", "1", "Cadalora", "17082026", "18082026", "Class 1", "SM", "null", "34.123", "91.2", "374", "11118.075", "171.3", "64922"]
  ]);
  const gridAugust = gridWithHeader(FLOWMASTER_HEADER, [
    ["2608999999", "2", "Some Other Variety", "01092026", "02092026", "Green", "XL", "null", "999.9", "200.0", "5000", "50000.0", "180.0", "99999"]
  ]);

  const hashJune = computeFingerprintHash(computeFingerprint(gridJune, ",", 0));
  const hashAugust = computeFingerprintHash(computeFingerprint(gridAugust, ",", 0));
  assert.equal(hashJune, hashAugust);
});

test("matchFingerprint: exact hash match auto-selects the saved template", () => {
  const grid = gridWithHeader(FLOWMASTER_HEADER);
  const fp = computeFingerprint(grid, ",", 0);
  const hash = computeFingerprintHash(fp);

  const saved = [{ id: "t1", name: "FlowMaster CSV Export", fingerprint: fp, fingerprintHash: hash }];
  const result = matchFingerprint(fp, hash, saved);

  assert.equal(result.kind, "exact");
  assert.equal(result.template?.id, "t1");
});

test("matchFingerprint: a changed layout (columns removed) is a close match requiring review, not auto-selected", () => {
  const savedGrid = gridWithHeader(FLOWMASTER_HEADER);
  const savedFp = computeFingerprint(savedGrid, ",", 0);
  const savedHash = computeFingerprintHash(savedFp);
  const saved = [{ id: "t1", name: "FlowMaster CSV Export", fingerprint: savedFp, fingerprintHash: savedHash }];

  // Same delimiter/header row, but one trailing column dropped (e.g. vendor
  // removed the final PCS column) — most headers still line up by position.
  const changedHeader = FLOWMASTER_HEADER.slice(0, -1);
  const changedGrid = gridWithHeader(changedHeader);
  const changedFp = computeFingerprint(changedGrid, ",", 0);
  const changedHash = computeFingerprintHash(changedFp);

  const result = matchFingerprint(changedFp, changedHash, saved);
  assert.equal(result.kind, "close");
  assert.equal(result.template?.id, "t1");
  assert.ok((result.similarity ?? 0) < 1);
});

test("matchFingerprint: an unrelated layout is no match at all", () => {
  const savedGrid = gridWithHeader(FLOWMASTER_HEADER);
  const savedFp = computeFingerprint(savedGrid, ",", 0);
  const savedHash = computeFingerprintHash(savedFp);
  const saved = [{ id: "t1", name: "FlowMaster CSV Export", fingerprint: savedFp, fingerprintHash: savedHash }];

  const unrelatedGrid = gridWithHeader(["Date", "Customer", "Amount"]);
  const unrelatedFp = computeFingerprint(unrelatedGrid, ",", 0);
  const unrelatedHash = computeFingerprintHash(unrelatedFp);

  const result = matchFingerprint(unrelatedFp, unrelatedHash, saved);
  assert.equal(result.kind, "none");
  assert.equal(result.template, null);
});

test("matchFingerprint: different delimiter never counts as close, even with identical headers", () => {
  const savedGrid = gridWithHeader(FLOWMASTER_HEADER);
  const savedFp = computeFingerprint(savedGrid, ",", 0);
  const savedHash = computeFingerprintHash(savedFp);
  const saved = [{ id: "t1", name: "FlowMaster CSV Export", fingerprint: savedFp, fingerprintHash: savedHash }];

  const semicolonFp = computeFingerprint(gridWithHeader(FLOWMASTER_HEADER), ";", 0);
  const semicolonHash = computeFingerprintHash(semicolonFp);

  const result = matchFingerprint(semicolonFp, semicolonHash, saved);
  assert.equal(result.kind, "none");
});
