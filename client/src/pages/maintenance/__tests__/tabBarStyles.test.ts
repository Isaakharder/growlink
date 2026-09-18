import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom doesn't run a real layout engine, so it can't prove text fits at
// a given viewport width — these are structural guards against the
// specific regression that caused labels to truncate ("Equi…"): the tab
// button rule using text-overflow/white-space/overflow to clip instead of
// wrap, and the 320px fallback grid being missing or reverted to 4
// columns. Actual pixel-fit is verified by the manual/live checks at
// 320/375/390/430px described in the task, not by this file.
//
// Resolved against process.cwd() (the client/ dir under `npm test`), not
// new URL("...css", import.meta.url) — Vite's static-asset transform
// specially intercepts new URL(...) calls targeting .css (unlike .ts/.tsx),
// producing a URL object node:url's fileURLToPath then rejects.
function readCss(): string {
  return readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
}

function ruleBodyFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No CSS rule found for selector: ${selector}`);
  return match[1];
}

describe("Maintenance tab bar — no-truncation CSS contract", () => {
  it(".maintenance-tab-button does not clip or ellipsize its label", () => {
    const body = ruleBodyFor(readCss(), ".maintenance-tab-button");
    expect(body).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(body).not.toMatch(/overflow\s*:\s*hidden/);
    expect(body).not.toMatch(/white-space\s*:\s*nowrap/);
  });

  it(".maintenance-tab-button keeps a >=44px minimum touch height", () => {
    const body = ruleBodyFor(readCss(), ".maintenance-tab-button");
    const match = body.match(/min-height\s*:\s*(\d+)px/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(44);
  });

  it("the base tab bar is a responsive four-column grid", () => {
    const body = ruleBodyFor(readCss(), ".maintenance-tab-bar");
    expect(body).toMatch(/grid-template-columns\s*:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  });

  it("a narrow-width media query falls back the tab bar to a two-column grid (never horizontal scroll)", () => {
    const css = readCss();
    const mediaMatch = css.match(/@media \(max-width: 374px\) \{([\s\S]*?)\n\}\n/);
    expect(mediaMatch).not.toBeNull();
    const mediaBlock = mediaMatch?.[1] ?? "";
    expect(mediaBlock).toContain(".maintenance-tab-bar");
    expect(mediaBlock).toMatch(/grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });

  it("the tab bar container has no overflow-x that would allow horizontal scrolling", () => {
    const body = ruleBodyFor(readCss(), ".maintenance-tab-bar");
    expect(body).not.toMatch(/overflow-x\s*:\s*auto/);
    expect(body).not.toMatch(/overflow\s*:\s*auto/);
  });
});

describe("Maintenance chip/scan-button specificity contract", () => {
  it(".maintenance-chip and .maintenance-scan-button are scoped with .maintenance-page so they win over the generic button rule", () => {
    const css = readCss();
    expect(css).toMatch(/\.maintenance-page \.maintenance-chip\s*\{/);
    expect(css).toMatch(/\.maintenance-page \.maintenance-scan-button\s*\{/);
  });
});
