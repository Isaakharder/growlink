import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Styles for components/charts/FullscreenChart.tsx (shared by the Yield
// Analytics and Dashboard trend charts). jsdom does no layout, so fit is
// pinned by the rules; the rendering was checked in a browser at 320-1440 px.
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8");
const start = css.indexOf("/* ── Full-screen chart (components/charts/FullscreenChart.tsx)");
const end = css.indexOf("\n/* ── ", start + 1);
const block = css.slice(start, end === -1 ? undefined : end);

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[2];
}
const phone = block.slice(block.indexOf("@media (max-width: 640px)"));

describe("shared full-screen chart styles", () => {
  it("only styles the full-screen chart and the Dashboard chart's focus ring", () => {
    expect(start).toBeGreaterThan(-1);
    const selectors = block
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media[^{]*\{/g, "")
      .match(/(^|\})\s*([^{}@]+)\{/g)!
      .map((s) => s.replace(/^\}?\s*/, "").replace(/\{$/, "").trim())
      .filter(Boolean);
    for (const selector of selectors) {
      for (const part of selector.split(",")) expect(part.trim(), selector).toMatch(/^\.(chart-|dashboard-chart-wrapper )/);
    }
  });

  it("is a fixed full-viewport layer using 100dvh, safe areas and contained overscroll", () => {
    const overlay = rule(block, ".chart-fullscreen");
    expect(overlay).toMatch(/position:\s*fixed/);
    expect(overlay).toMatch(/height:\s*100vh;\s*height:\s*100dvh/);
    for (const side of ["top", "right", "bottom", "left"]) expect(overlay).toContain(`env(safe-area-inset-${side}, 0px)`);
    expect(overlay).toMatch(/overscroll-behavior:\s*contain/);
    // It sits outside any page, so it defines the button variables it needs.
    expect(overlay).toContain("--csv-tb-focus:");
    const body = rule(block, ".chart-fullscreen-body");
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(body).toMatch(/min-height:\s*0/);
  });

  it("gives the Expand button a 40 px target, 44 px on phones", () => {
    expect(rule(block, ".chart-expand-button")).toMatch(/min-height:\s*40px/);
    expect(rule(phone, "  .chart-expand-button")).toMatch(/min-height:\s*44px/);
  });
});
