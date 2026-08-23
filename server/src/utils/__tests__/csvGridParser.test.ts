import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenizeCsvRows,
  detectDelimiter,
  decodeCsvBuffer,
  parseCsvGrid,
  parseCsvGridFromBuffer
} from "../csvGridParser";

test("tokenizeCsvRows splits basic comma rows", () => {
  const rows = tokenizeCsvRows("a,b,c\n1,2,3", ",");
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "2", "3"]
  ]);
});

test("tokenizeCsvRows handles quoted fields with embedded delimiter, newline, and escaped quote", () => {
  const text = 'name,note\n"Smith, John","Line one\nLine two"\n"He said ""hi""",ok';
  const rows = tokenizeCsvRows(text, ",");
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Smith, John", "Line one\nLine two"],
    ['He said "hi"', "ok"]
  ]);
});

test("tokenizeCsvRows normalizes CRLF line endings", () => {
  const rows = tokenizeCsvRows("a,b\r\n1,2\r\n", ",");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"]
  ]);
});

test("tokenizeCsvRows never interprets cell content as formulas or HTML — cells are always plain strings", () => {
  const rows = tokenizeCsvRows('formula,html\n"=SUM(A1:A2)","<script>alert(1)</script>"', ",");
  assert.equal(rows[1][0], "=SUM(A1:A2)");
  assert.equal(rows[1][1], "<script>alert(1)</script>");
});

test("detectDelimiter picks comma for a comma-delimited file", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3\n4,5,6"), ",");
});

test("detectDelimiter picks semicolon for a semicolon-delimited file", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3\n4;5;6"), ";");
});

test("detectDelimiter picks tab for a tab-delimited file", () => {
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3\n4\t5\t6"), "\t");
});

test("detectDelimiter picks pipe for a pipe-delimited file", () => {
  assert.equal(detectDelimiter("a|b|c\n1|2|3\n4|5|6"), "|");
});

test("decodeCsvBuffer strips a UTF-8 BOM", () => {
  const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n1,2", "utf-8")]);
  const result = decodeCsvBuffer(buffer);
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.hadBom, true);
  assert.equal(result.text, "a,b\n1,2");
});

test("decodeCsvBuffer strips a UTF-16LE BOM and decodes correctly", () => {
  const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n1,2", "utf16le")]);
  const result = decodeCsvBuffer(buffer);
  assert.equal(result.encoding, "utf-16le");
  assert.equal(result.hadBom, true);
  assert.equal(result.text, "a,b\n1,2");
});

test("decodeCsvBuffer defaults to UTF-8 with no BOM present", () => {
  const buffer = Buffer.from("a,b\n1,2", "utf-8");
  const result = decodeCsvBuffer(buffer);
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.hadBom, false);
});

test("parseCsvGrid reports row/column counts and detected delimiter", () => {
  const grid = parseCsvGrid("a,b,c\n1,2,3\n4,5,6");
  assert.equal(grid.rowCount, 3);
  assert.equal(grid.columnCount, 3);
  assert.equal(grid.delimiter, ",");
});

test("parseCsvGrid honors an explicit delimiter override, skipping auto-detection", () => {
  // This text would auto-detect as comma-delimited, but a saved template
  // might specify semicolon for a file that happens to also contain commas
  // inside unquoted text — the override must always win.
  const grid = parseCsvGrid("a;b;c\n1,2;3;4", ";");
  assert.equal(grid.delimiter, ";");
  assert.deepEqual(grid.rows[1], ["1,2", "3", "4"]);
});

test("parseCsvGridFromBuffer produces duplicate-position column headers unchanged (no dedup/rename) — position is preserved for downstream mapping", () => {
  const buffer = Buffer.from("WEIGHT,AVG,PCS,WEIGHT,AVG,PCS\n1,2,3,4,5,6", "utf-8");
  const grid = parseCsvGridFromBuffer(buffer);
  assert.deepEqual(grid.rows[0], ["WEIGHT", "AVG", "PCS", "WEIGHT", "AVG", "PCS"]);
  assert.equal(grid.columnCount, 6);
});
