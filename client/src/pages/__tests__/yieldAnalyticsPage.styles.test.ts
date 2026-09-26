import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Structural checks on the Yield Analytics styles. jsdom does no layout, so
// fit and containment are pinned by the rules that produce them; the real
// rendering was checked in a browser at 320-1440 px.
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8");
const start = css.indexOf("/* ── Yield Analytics page");
const end = css.indexOf("\n/* ── ", start + 1);
const yaCss = css.slice(start, end === -1 ? undefined : end);

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[2];
}

function mediaBlock(query: string): string {
  const at = yaCss.indexOf(`@media (${query})`);
  if (at === -1) throw new Error(`No @media (${query})`);
  let depth = 0;
  for (let i = yaCss.indexOf("{", at); i < yaCss.length; i += 1) {
    if (yaCss[i] === "{") depth += 1;
    if (yaCss[i] === "}") depth -= 1;
    if (depth === 0) return yaCss.slice(at, i + 1);
  }
  throw new Error("Unbalanced @media block");
}

describe("Yield Analytics page styles", () => {
  it("scopes every rule to ya-* classes or the page", () => {
    const selectors = yaCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@keyframes[^{]*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "")
      .replace(/@media[^{]*\{/g, "")
      .match(/(^|\})\s*([^{}@]+)\{/g)!
      .map((s) => s.replace(/^\}?\s*/, "").replace(/\{$/, "").trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(30);
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim(), selector).toMatch(/^\.ya-/);
      }
    }
  });

  it("defines the variables the reused csv-tb-btn buttons read, on this page only", () => {
    const vars = rule(yaCss, ".ya-page");
    for (const name of ["--csv-tb-focus", "--csv-tb-brand-dark", "--csv-tb-danger", "--csv-tb-warning"]) {
      expect(vars).toContain(`${name}:`);
    }
  });

  it("gives filter selects application-control sizing, with 44 px targets and stacked filters on phones", () => {
    const select = rule(yaCss, ".ya-select");
    expect(select).toMatch(/appearance:\s*none/);
    expect(select).toMatch(/min-height:\s*40px/);
    expect(rule(yaCss, ".ya-select:focus-visible")).toMatch(/outline:\s*3px solid/);
    const phone = mediaBlock("max-width: 640px");
    expect(rule(phone, "  .ya-select")).toMatch(/min-height:\s*44px/);
    expect(rule(phone, "  .ya-export-item")).toMatch(/min-height:\s*44px/);
    expect(rule(phone, "  .ya-filters-row,\n  .ya-filter-fields")).toMatch(/flex-direction:\s*column/);
  });

  it("fits charts to their card instead of the old 560 px scrolling minimum", () => {
    expect(rule(yaCss, ".ya-page .ya-chart > div")).toMatch(/min-width:\s*0/);
    expect(rule(yaCss, ".ya-page .ya-chart")).toMatch(/height:\s*320px/);
  });

  it("contains wide tables in their own scroll box with the identifying column pinned", () => {
    expect(rule(yaCss, ".ya-page .ya-table-scroll")).toMatch(/overflow-x:\s*auto/);
    const sticky = rule(yaCss, ".ya-page .ya-table th:first-child");
    expect(sticky).toMatch(/position:\s*sticky/);
    expect(sticky).toMatch(/left:\s*0/);
    expect(rule(yaCss, ".ya-page .ya-table td,\n.ya-page .ya-table thead th:not(:first-child)")).toMatch(/text-align:\s*right/);
  });

  it("lays metric cards out two per row on phones, with Total kg across the full width", () => {
    const phone = mediaBlock("max-width: 640px");
    expect(rule(phone, "  .ya-kpi-grid")).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(rule(phone, "  .ya-kpi--primary")).toMatch(/grid-column:\s*1 \/ -1/);
  });

  it("uses no fixed widths that could overflow a 320 px screen", () => {
    const widths = Array.from(yaCss.matchAll(/(?:^|[;\s])(?:min-)?width:\s*(\d+(?:\.\d+)?)px/g)).map((m) => Number(m[1]));
    for (const w of widths) expect(w).toBeLessThanOrEqual(1);
  });

  it("stops the loading shimmer for reduced motion", () => {
    expect(rule(mediaBlock("prefers-reduced-motion: reduce"), "  .ya-skeleton")).toMatch(/animation:\s*none/);
  });
});
