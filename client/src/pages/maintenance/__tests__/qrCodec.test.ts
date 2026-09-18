import { describe, expect, it } from "vitest";
import { looksLikeEquipmentQrToken } from "../qrCodec";

describe("looksLikeEquipmentQrToken", () => {
  it("accepts a well-formed UUID (with surrounding whitespace, as a scanner might read it)", () => {
    expect(looksLikeEquipmentQrToken("  3fa85f64-5717-4562-b3fc-2c963f66afa6  ")).toBe(true);
    expect(looksLikeEquipmentQrToken("3FA85F64-5717-4562-B3FC-2C963F66AFA6")).toBe(true);
  });

  it("rejects an asset code or arbitrary text (the manual-entry path, not the token lookup path)", () => {
    expect(looksLikeEquipmentQrToken("MOWER-001")).toBe(false);
    expect(looksLikeEquipmentQrToken("")).toBe(false);
    expect(looksLikeEquipmentQrToken("not-a-uuid-at-all")).toBe(false);
  });

  it("rejects a QR payload from an unrelated app (e.g. a URL) rather than misreading it as a token", () => {
    expect(looksLikeEquipmentQrToken("https://example.com/not-growlink")).toBe(false);
  });
});
