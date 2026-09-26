import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Structural checks on the CSV Templates page styles (jsdom does no layout,
// so wrapping/overflow are pinned by the rules that produce them; the real
// rendering was checked in a browser at 320-1440 px) and on the builder
// staying out of the main bundle.
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8");
const csvTbCss = css.slice(css.indexOf("/* ── CSV Templates page: sections, buttons and template cards"));

/** The declarations of the first rule whose selector list is exactly `selector` within `source`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No rule for ${selector}`);
  return match[2];
}

function mediaBlock(query: string): string {
  const start = csvTbCss.indexOf(`@media (${query})`);
  if (start === -1) throw new Error(`No @media (${query})`);
  let depth = 0;
  for (let i = csvTbCss.indexOf("{", start); i < csvTbCss.length; i += 1) {
    if (csvTbCss[i] === "{") depth += 1;
    if (csvTbCss[i] === "}") depth -= 1;
    if (depth === 0) return csvTbCss.slice(start, i + 1);
  }
  throw new Error("Unbalanced @media block");
}

describe("CSV Templates page styles", () => {
  it("scopes every new rule to csv-tb-* or the builder — no global button rules", () => {
    const selectors = csvTbCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media[^{]*\{/g, "")
      .match(/(^|\})\s*([^{}@]+)\{/g)!
      .map((s) => s.replace(/^\}?\s*/, "").replace(/\{$/, "").trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim(), selector).toMatch(/^\.(csv-tb-|csv-template-builder)/);
      }
    }
  });

  it("gives buttons application-control sizing and visible focus, never the browser default look", () => {
    const base = rule(csvTbCss, ".csv-tb-btn");
    expect(base).toMatch(/appearance:\s*none/);
    expect(base).toMatch(/min-height:\s*40px/);
    expect(base).toMatch(/padding:\s*0\.45rem 1rem/);
    expect(base).toMatch(/max-width:\s*100%/);
    expect(rule(csvTbCss, ".csv-tb-btn:focus-visible")).toMatch(/outline:\s*3px solid/);
  });

  it("lets header actions and toolbars wrap, and stacks them with 44 px targets on phones", () => {
    for (const selector of [".csv-tb-section-header", ".csv-tb-section-actions", ".csv-tb-toolbar", ".csv-tb-template-meta", ".csv-tb-template-head"]) {
      expect(rule(csvTbCss, selector), selector).toMatch(/flex-wrap:\s*wrap/);
    }
    const phone = mediaBlock("max-width: 640px");
    expect(rule(phone, "  .csv-tb-btn")).toMatch(/min-height:\s*44px/);
    expect(rule(phone, "  .csv-tb-section-actions")).toMatch(/width:\s*100%/);
  });

  it("uses no fixed widths that could overflow a 320 px screen", () => {
    const widths = Array.from(csvTbCss.matchAll(/(?:^|[;\s])(?:min-)?width:\s*(\d+(?:\.\d+)?)px/g)).map((m) => Number(m[1]));
    for (const w of widths) expect(w).toBeLessThanOrEqual(8);
  });

  it("keeps destructive, warning and disabled states visually distinct", () => {
    const danger = rule(csvTbCss, ".csv-tb-btn--danger");
    const warning = rule(csvTbCss, ".csv-tb-btn--warning");
    const disabled = rule(csvTbCss, ".csv-tb-btn:disabled");
    expect(danger).toMatch(/color:\s*var\(--csv-tb-danger\)/);
    expect(warning).toMatch(/color:\s*var\(--csv-tb-warning\)/);
    // Disabled dims whatever variant it is instead of recolouring it, so a disabled Delete still reads as Delete.
    expect(disabled).toMatch(/opacity:\s*0\.5/);
    expect(disabled).not.toMatch(/color:/);
  });

  it("turns a disabled primary neutral so it never looks like an available green action", () => {
    const disabledPrimary = rule(csvTbCss, ".csv-tb-btn--primary:disabled");
    expect(disabledPrimary).toMatch(/background:\s*var\(--surface-soft\)/);
    expect(disabledPrimary).toMatch(/color:\s*var\(--text-muted\)/);
  });

  it("keeps Disable and Delete together when the toolbar wraps, and lays phones out in fitted columns", () => {
    expect(rule(csvTbCss, ".csv-tb-toolbar-group")).toMatch(/display:\s*inline-flex/);
    const phone = mediaBlock("max-width: 640px");
    expect(rule(phone, "  .csv-tb-toolbar")).toMatch(/grid-template-columns:\s*repeat\(auto-fit, minmax\(8\.5rem, 1fr\)\)/);
    expect(rule(phone, "  .csv-tb-toolbar-group")).toMatch(/display:\s*contents/);
  });

  it("respects reduced motion", () => {
    expect(rule(mediaBlock("prefers-reduced-motion: reduce"), "  .csv-tb-btn")).toMatch(/transition:\s*none/);
  });
});

describe("CSV Template Builder bundle placement", () => {
  it("is only ever reached through the lazy import in YieldDataEntryPage", () => {
    const page = readFileSync(resolve(process.cwd(), "src/pages/YieldDataEntryPage.tsx"), "utf-8");
    expect(page).toMatch(/lazy\(\(\) =>\s*import\("\.\/CsvTemplateBuilderTab"\)/);
    expect(page).not.toMatch(/^import .*CsvTemplateBuilderTab/m);
  });
});
