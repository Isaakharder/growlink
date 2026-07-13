import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseActive,
  parseOptionalText,
  parseOrderedIds,
  parseRequiredName,
  parseSortOrder
} from "../services/validation";

test("parseRequiredName trims and requires a non-empty string", () => {
  assert.equal(parseRequiredName("  Chemical Storage  "), "Chemical Storage");
  assert.throws(() => parseRequiredName(""), /name is required/);
  assert.throws(() => parseRequiredName("   "), /name is required/);
  assert.throws(() => parseRequiredName(undefined), /name is required/);
  assert.throws(() => parseRequiredName(42), /name is required/);
});

test("parseOptionalText allows null/undefined, trims, rejects non-strings", () => {
  assert.equal(parseOptionalText(null, "description"), null);
  assert.equal(parseOptionalText(undefined, "description"), null);
  assert.equal(parseOptionalText("  ", "description"), null);
  assert.equal(parseOptionalText("  hello  ", "description"), "hello");
  assert.throws(() => parseOptionalText(123, "description"), /description must be a string/);
});

test("parseActive defaults to true and requires a boolean when provided", () => {
  assert.equal(parseActive(undefined), true);
  assert.equal(parseActive(true), true);
  assert.equal(parseActive(false), false);
  assert.throws(() => parseActive("true"), /active must be a boolean/);
});

test("parseSortOrder defaults to 0 and requires an integer", () => {
  assert.equal(parseSortOrder(undefined), 0);
  assert.equal(parseSortOrder(3), 3);
  assert.equal(parseSortOrder("5"), 5);
  assert.throws(() => parseSortOrder(1.5), /sort_order must be an integer/);
  assert.throws(() => parseSortOrder("not-a-number"), /sort_order must be an integer/);
});

test("parseOrderedIds requires a non-empty array of non-empty strings", () => {
  assert.deepEqual(parseOrderedIds({ orderedIds: ["a", "b", "c"] }), ["a", "b", "c"]);
  assert.throws(() => parseOrderedIds({}), /orderedIds must be a non-empty array/);
  assert.throws(() => parseOrderedIds({ orderedIds: [] }), /orderedIds must be a non-empty array/);
  assert.throws(() => parseOrderedIds({ orderedIds: ["a", ""] }), /orderedIds must contain non-empty strings/);
  assert.throws(() => parseOrderedIds({ orderedIds: ["a", 5] }), /orderedIds must contain non-empty strings/);
  assert.throws(() => parseOrderedIds(null), /Invalid request body/);
});
