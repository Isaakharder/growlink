import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural guard, on top of nativeRoutes.test.tsx's behavioral coverage:
// the guarantee that no desktop route can end up in the native iOS bundle
// isn't "the tests we wrote don't render one" — it's that router/nativeRoutes.tsx
// never imports a desktop page component at all, so there is nothing for a
// stray deep link (or a future edit) to accidentally reach.
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

// Explanatory comments in these files legitimately mention the exact
// strings/tags being asserted against below (e.g. "never calls
// registerSW()", "No <link rel=\"manifest\">") — matching on raw source
// text would make those comments self-defeating. Stripping comments first
// means the assertions check what the code (or markup) actually DOES.
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

// A representative sample of desktop-only pages (from router/routes.tsx's
// "/" tree) that must never be importable from the native router.
const DESKTOP_ONLY_IDENTIFIERS = [
  "DashboardPage",
  "AppLayout",
  "IrrigationPage",
  "IrrigationSetupPage",
  "YieldAnalyticsPage",
  "YieldDataEntryPage",
  "GreenhouseSetupPage",
  "PestControlSetupPage",
  "QualityCheckPage",
  "AdminOrganizationsPage",
  "PlatformCustomersPage",
  "SettingsPage",
  "FoodSafetySetupPage",
  "VarietiesSetupPage"
];

describe("router/nativeRoutes.tsx — cannot reach a desktop route", () => {
  const source = readSource("../nativeRoutes.tsx");
  const code = stripJsComments(source);

  it("never imports any desktop-only page component", () => {
    for (const identifier of DESKTOP_ONLY_IDENTIFIERS) {
      expect(code).not.toMatch(new RegExp(`\\b${identifier}\\b`));
    }
  });

  it("reuses mobileRouteChildren from router/routes.ts rather than declaring its own duplicate route list", () => {
    expect(source).toMatch(/import\s*\{\s*mobileRouteChildren\s*\}\s*from\s*["']\.\/routes["']/);
    expect(source).toMatch(/children:\s*mobileRouteChildren/);
  });

  it("mounts the shared mobile route tree at \"/\", not \"/mobile\"", () => {
    // The MobileLayout branch must sit directly under the "/" RequireAuth
    // route, not nested under a "/mobile" path segment like the web router.
    expect(source).not.toMatch(/path:\s*["']\/mobile["']/);
    expect(source).toMatch(/path:\s*["']\/["'][\s\S]*element:\s*<RequireAuth/);
  });

  it("has a catch-all that redirects any unmatched path back to Mobile Home, never leaving it unhandled", () => {
    expect(source).toMatch(/path:\s*["']\*["'][\s\S]{0,80}<Navigate to="\/" replace \/>/);
  });
});

describe("vite.ios.config.ts — the native build contains only the mobile shell", () => {
  const config = stripJsComments(readSource("../../../vite.ios.config.ts"));

  it("has a single entry pointing at native.html (main.native.tsx), not index.html/mobile.html", () => {
    expect(config).toMatch(/native\.html/);
    expect(config).not.toMatch(/["']index\.html["']/);
    expect(config).not.toMatch(/["']mobile\.html["']/);
  });

  it("does not include the VitePWA plugin — no PWA service worker in the native build", () => {
    expect(config).not.toMatch(/VitePWA/);
    expect(config).not.toMatch(/vite-plugin-pwa/);
  });

  it("outputs to dist-ios, not dist (the Railway web/PWA build's own output directory)", () => {
    expect(config).toMatch(/outDir:\s*["']dist-ios["']/);
  });
});

describe("native.html — the native entry document has no PWA/service-worker wiring", () => {
  const html = stripHtmlComments(readSource("../../../native.html"));

  it("loads main.native.tsx, not main.tsx", () => {
    expect(html).toMatch(/src="\/src\/main\.native\.tsx"/);
  });

  it("has no <link rel=\"manifest\"> (no web app manifest natively)", () => {
    expect(html).not.toMatch(/rel="manifest"/);
  });
});

describe("main.native.tsx — never registers the PWA service worker", () => {
  const source = stripJsComments(readSource("../../main.native.tsx"));

  it("does not call registerSW or import virtual:pwa-register", () => {
    expect(source).not.toMatch(/registerSW/);
    expect(source).not.toMatch(/virtual:pwa-register/);
  });

  it("renders nativeRouter, not the web appRouter", () => {
    expect(source).toMatch(/import\s*\{\s*nativeRouter\s*\}\s*from\s*["']\.\/router\/nativeRoutes["']/);
    expect(source).not.toMatch(/appRouter/);
  });
});
