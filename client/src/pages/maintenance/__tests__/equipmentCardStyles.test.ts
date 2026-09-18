import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guard against the readability regression: equipment (and
// inventory/restock/stock-count) cards are `<button class="maintenance-card
// maintenance-equipment-card">`, and without the `.maintenance-page` scope
// the later, equally-general `.maintenance-page button` rule (higher
// specificity) silently forced a dark green background with white title
// text while `.maintenance-card-meta-row`'s own `color: var(--text-muted)`
// (dark gray) still applied to the nested detail spans — producing dark
// gray text on a dark green background. jsdom can't compute real contrast,
// so this asserts the source rule directly.
function readCss(): string {
  return readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
}

function ruleBodyFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No CSS rule found for selector: ${selector}`);
  return match[1];
}

describe("Maintenance equipment card — readable-contrast CSS contract", () => {
  it(".maintenance-equipment-card is scoped with .maintenance-page so it wins over the generic (green/white) button rule", () => {
    const css = readCss();
    expect(css).toMatch(/\.maintenance-page \.maintenance-equipment-card\s*\{/);
  });

  it("the card sets a light surface background and dark text, not the brand-green button background", () => {
    const body = ruleBodyFor(readCss(), ".maintenance-page .maintenance-equipment-card");
    expect(body).toMatch(/background\s*:\s*var\(--surface\)/);
    expect(body).toMatch(/color\s*:\s*var\(--text\)/);
    expect(body).not.toMatch(/background\s*:\s*var\(--brand\)/);
    expect(body).not.toMatch(/color\s*:\s*#fff/);
  });

  it("status and maintenance-condition badges have distinct, non-green color variants (not just the card's own background)", () => {
    const css = readCss();
    for (const variant of ["ok", "warning", "danger", "neutral"]) {
      expect(css).toMatch(new RegExp(`\\.maintenance-status-badge\\.${variant}\\s*\\{`));
    }
  });
});
