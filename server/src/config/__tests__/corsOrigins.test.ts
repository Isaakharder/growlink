import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_ORIGINS, isAllowedOrigin, normalizeOrigin, parseAllowedOrigins } from "../corsOrigins";

test("normalizeOrigin reduces an address to scheme://host[:port], lower-cased", () => {
  assert.equal(normalizeOrigin("https://growlink.lltech.io"), "https://growlink.lltech.io");
  assert.equal(normalizeOrigin(" https://growlink.lltech.io/ "), "https://growlink.lltech.io");
  assert.equal(normalizeOrigin("https://GrowLink.LLTech.io/login?x=1"), "https://growlink.lltech.io");
  assert.equal(normalizeOrigin('"https://growlink.lltech.io"'), "https://growlink.lltech.io");
  assert.equal(normalizeOrigin("https://growlink.lltech.io:443"), "https://growlink.lltech.io");
  assert.equal(normalizeOrigin("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(normalizeOrigin("capacitor://localhost"), "capacitor://localhost");
  for (const bad of ["", "   ", "*", "null", "growlink.lltech.io", "https://", undefined]) {
    assert.equal(normalizeOrigin(bad), null, String(bad));
  }
});

test("parseAllowedOrigins keeps the dev and iOS origins and adds each CORS_ORIGINS entry", () => {
  const { origins, invalid } = parseAllowedOrigins(
    " https://growlinkclient-production.up.railway.app , https://growlink.lltech.io/,, *, growlink.lltech.io "
  );
  for (const o of DEV_ORIGINS) assert.ok(origins.has(o), o);
  assert.ok(origins.has("capacitor://localhost"));
  assert.ok(origins.has("https://growlinkclient-production.up.railway.app"));
  assert.ok(origins.has("https://growlink.lltech.io"));
  assert.deepEqual(invalid, ["*", "growlink.lltech.io"]);
  assert.deepEqual(parseAllowedOrigins(undefined), { origins: new Set(DEV_ORIGINS), invalid: [] });
});

test("isAllowedOrigin matches exact origins only", () => {
  const { origins } = parseAllowedOrigins("https://growlink.lltech.io,https://growlinkclient-production.up.railway.app");
  assert.equal(isAllowedOrigin(origins, "https://growlink.lltech.io"), true);
  assert.equal(isAllowedOrigin(origins, "https://growlinkclient-production.up.railway.app"), true);
  assert.equal(isAllowedOrigin(origins, "capacitor://localhost"), true);
  for (const o of [
    "http://growlink.lltech.io",
    "https://www.growlink.lltech.io",
    "https://growlink.lltech.io.evil.example",
    "https://evilgrowlink.lltech.io",
    "https://growlink.lltech.io:8443",
    "null",
    ""
  ]) {
    assert.equal(isAllowedOrigin(origins, o), false, o);
  }
});
