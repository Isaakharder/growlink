import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

// CSS has no "//" line comments (unlike stripJsComments, which also
// strips those) — a bare "//" can legitimately appear in CSS, e.g. inside
// a url(). Only /* */ block comments are ever actually comments here.
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Swift uses both // and /* */ comments, unlike CSS.
function stripSwiftComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// index.css must be read via process.cwd(), NOT
// fileURLToPath(new URL(..., import.meta.url)) like readSource() above —
// Vite's static-asset transform intercepts new URL() calls whose target
// ends in .css specifically (but not .ts/.tsx/.html), producing a URL
// object node:url's fileURLToPath then rejects with "The URL must be of
// scheme file." Discovered and fixed once already (see
// pages/maintenance/__tests__/equipmentCardStyles.test.ts); readSource()
// itself is left alone since every OTHER file it reads in this file is
// fine with the import.meta.url form.
function readCss(): string {
  return readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");
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

  it("mounts the shared mobile route tree at \"mobile\" (i.e. \"/mobile\"), the same path the web router uses", () => {
    // Regression test for the bug this fix addresses: mounting at "/"
    // instead of "/mobile" made every mobile page's plain "/mobile/..."
    // links (e.g. EquipmentTab's equipment-detail navigation) 404 under
    // the native router, since only links that went through
    // mobilePath()/MOBILE_HOME were rewritten. Mounting at the identical
    // path as web means a literal "/mobile/..." string is correct under
    // either router — no per-component conversion required.
    expect(source).toMatch(/path:\s*["']mobile["'][\s\S]*element:\s*<MobileLayout/);
  });

  it("redirects the bare \"/\" route to \"/mobile\" instead of mounting MobileLayout there directly", () => {
    expect(source).toMatch(/index:\s*true[\s\S]{0,40}<Navigate to="\/mobile" replace \/>/);
  });

  it("has a catch-all that redirects any unmatched path to Mobile Home (\"/mobile\"), never leaving it unhandled", () => {
    expect(source).toMatch(/path:\s*["']\*["'][\s\S]{0,80}<Navigate to="\/mobile" replace \/>/);
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

describe("capacitor.config.ts — native bridge logging is fully disabled", () => {
  // Regression test for a real leak: a first physical-device Debug build
  // printed the complete Supabase session (access token included) to the
  // Xcode console via Capacitor's own bridge logging, because Capacitor's
  // default loggingBehavior ("debug") logs native plugin call
  // arguments/results — including whatever SecureStorage's native getItem
  // returned. "none" is a single top-level setting read from one
  // capacitor.config.json bundled into the app for every build
  // configuration (see capacitor.config.ts's own comment) — there is no
  // separate Debug/Release value to get out of sync, so one assertion
  // covers both.
  const source = stripJsComments(readSource("../../../capacitor.config.ts"));

  it("sets the top-level loggingBehavior to \"none\"", () => {
    expect(source).toMatch(/loggingBehavior:\s*["']none["']/);
  });

  it("does not set loggingBehavior to \"debug\" or \"production\" anywhere (no weaker override)", () => {
    const loggingBehaviorValues = [...source.matchAll(/loggingBehavior:\s*["'](\w+)["']/g)].map((m) => m[1]);
    expect(loggingBehaviorValues.length).toBeGreaterThan(0);
    expect(loggingBehaviorValues.every((v) => v === "none")).toBe(true);
  });

  it("still uses Keychain-backed secure storage for the native auth adapter (this fix must not weaken it)", () => {
    const authStorage = stripJsComments(readSource("../../lib/nativeAuthStorage.ts"));
    expect(authStorage).toMatch(/@aparajita\/capacitor-secure-storage/);
    expect(authStorage).not.toMatch(/@capacitor\/preferences/);
  });
});

describe("ios/App/App/capacitor.config.json — the file Capacitor's native runtime actually reads", () => {
  // capacitor.config.ts is the source; this generated JSON (written by
  // `npx cap sync ios` from capacitor.config.ts) is what's bundled into
  // the app and what the native bridge reads at launch, in every build
  // configuration — this is the file to check to be sure the fix actually
  // reached the native project, not just the TypeScript source.
  it("has loggingBehavior \"none\" (run `npx cap sync ios` first if this fails after editing capacitor.config.ts)", () => {
    const json = JSON.parse(readSource("../../../ios/App/App/capacitor.config.json"));
    expect(json.loggingBehavior).toBe("none");
  });

  it("has backgroundColor \"#f7f9f8\" (run `npx cap sync ios` first if this fails after editing capacitor.config.ts)", () => {
    const json = JSON.parse(readSource("../../../ios/App/App/capacitor.config.json"));
    expect(json.backgroundColor).toBe("#f7f9f8");
  });
});

describe("iOS overscroll/background fix — every layer uses the SAME GrowLink Mobile page-background token (#f7f9f8), never a different or duplicated colour", () => {
  // Regression test for a real device bug: pulling to rubber-band scroll
  // past the top or bottom revealed a black native background. Root
  // cause, confirmed by reading @capacitor/ios's own installed source
  // (CAPBridgeViewController.swift): with no `backgroundColor` config set,
  // Capacitor falls back to UIColor.systemBackground for the WKWebView
  // and its scrollView, which renders black under system Dark Mode — and
  // that same source shows Capacitor's config never touches the
  // containing view controller's own .view or the UIWindow at all, which
  // is why the native Swift change in SceneDelegate.swift was also
  // needed, not just a config value.
  const MOBILE_BG_HEX = "#f7f9f8";

  it("capacitor.config.ts sets the top-level backgroundColor to the token (covers the WKWebView + its scrollView)", () => {
    const config = stripJsComments(readSource("../../../capacitor.config.ts"));
    expect(config).toMatch(new RegExp(`backgroundColor:\\s*["']${MOBILE_BG_HEX}["']`));
  });

  it("native.html's <body> carries the native-shell class that scopes the CSS fix to native only", () => {
    const html = stripHtmlComments(readSource("../../../native.html"));
    expect(html).toMatch(/<body[^>]*\bclass="native-shell"/);
  });

  it("index.css gives body.native-shell (and #root under it) the same flat token — scoped so desktop/web are untouched", () => {
    const css = stripCssComments(readCss());
    expect(css).toMatch(/body\.native-shell,\s*body\.native-shell #root\s*\{[^}]*background:\s*#f7f9f8/);
  });

  it("the desktop/web body rule (unscoped, shared by index.html and mobile.html) still has its own decorative gradient — proves this fix didn't touch it", () => {
    const css = stripCssComments(readCss());
    // The desktop body background is distinctive enough (its two named
    // corner gradients) that just confirming it's still present, intact,
    // proves this fix left it alone — it's the ONLY rule that has it.
    expect(css).toMatch(/radial-gradient\(circle at 10% -10%, #eef8f4/);

    // And the scoped native-shell override itself must NOT carry that
    // gradient — it's a flat colour, not "the gradient, scoped."
    const nativeShellRule = css.match(/body\.native-shell,\s*body\.native-shell #root\s*\{([^}]*)\}/);
    expect(nativeShellRule).not.toBeNull();
    expect(nativeShellRule![1]).not.toMatch(/radial-gradient/);
  });

  it(".mobile-layout (the mobile app's own root container, rendered on both web and native) already uses the same token", () => {
    const css = stripCssComments(readCss());
    const mobileLayoutRule = css.match(/\.mobile-layout\s*\{([^}]*)\}/);
    expect(mobileLayoutRule).not.toBeNull();
    expect(mobileLayoutRule![1]).toMatch(new RegExp(`background:\\s*${MOBILE_BG_HEX.replace("#", "#")}`));
  });

  it("SceneDelegate.swift sets both the window's and the root view controller's view background to the token's exact RGB (0xF7, 0xF9, 0xF8), covering the layers capacitor.config.ts's backgroundColor cannot reach", () => {
    const swift = stripSwiftComments(readSource("../../../ios/App/App/SceneDelegate.swift"));
    expect(swift).toMatch(/0xF7\s*\/\s*255\.0.*0xF9\s*\/\s*255\.0.*0xF8\s*\/\s*255\.0/s);
    expect(swift).toMatch(/window\?\.backgroundColor\s*=\s*mobileBackground/);
    expect(swift).toMatch(/window\?\.rootViewController\?\.view\.backgroundColor\s*=\s*mobileBackground/);
  });

  it("normal iOS bounce scrolling is preserved — this fix never sets scrollView.bounces or disables scrolling anywhere", () => {
    const swift = stripSwiftComments(readSource("../../../ios/App/App/SceneDelegate.swift"));
    expect(swift).not.toMatch(/\.bounces\s*=/);
    expect(swift).not.toMatch(/isScrollEnabled\s*=\s*false/);
    const css = stripCssComments(readCss());
    expect(css).not.toMatch(/overscroll-behavior\s*:\s*none/);
  });
});
