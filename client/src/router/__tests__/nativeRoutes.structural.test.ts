import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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

// For binary assets (PNGs) — reading as utf8 would corrupt the bytes, which
// matters here because these are read for their raw IHDR header fields and
// SHA-256 checksums, not as text.
function readBinarySource(relativePath: string): Buffer {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)));
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

  it("has plugins.StatusBar.backgroundColor \"#f7f9f8\", not the plugin's own black default (run `npx cap sync ios` first if this fails)", () => {
    const json = JSON.parse(readSource("../../../ios/App/App/capacitor.config.json"));
    expect(json.plugins?.StatusBar?.backgroundColor).toBe("#f7f9f8");
    expect(json.plugins?.StatusBar?.overlaysWebView).toBe(false);
  });
});

describe("iOS overscroll/background fix — every layer uses the SAME GrowLink Mobile page-background token (#f7f9f8), never a different or duplicated colour", () => {
  // Regression test for a real device bug, fixed in two passes.
  //
  // Pass 1 (commit aec5918) fixed BOTTOM overscroll: with no
  // capacitor.config.ts `backgroundColor` set, Capacitor's
  // CAPBridgeViewController.swift (prepareWebView) falls back to
  // UIColor.systemBackground for the WKWebView and its scrollView, which
  // renders black under system Dark Mode.
  //
  // TOP overscroll stayed black after that fix. Root cause, confirmed by
  // reading @capacitor/ios's source before editing anything further:
  // CAPBridgeViewController.loadView() does `view = webView` — the view
  // controller's own .view IS the webview, already covered by the SAME
  // backgroundColor config, not a separate layer. The actual remaining
  // black view is a THIRD, distinct native ancestor: because
  // native/statusBar.ts calls StatusBar.setOverlaysWebView({overlay:
  // false}), @capacitor/status-bar's StatusBar.swift creates its own
  // "backgroundView" UIView covering exactly the status-bar strip, added
  // as a sibling of the webview directly under the window. That plugin's
  // own backgroundColor property defaults to UIColor.black
  // (StatusBarConfig.swift) and nothing had ever set it — fixed via
  // capacitor.config.ts's plugins.StatusBar.backgroundColor, which the
  // plugin reads at load() time, before any JS runs.
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

  it("SceneDelegate.swift sets the window's background to the token's exact RGB (0xF7, 0xF9, 0xF8) — the one layer capacitor.config.ts's backgroundColor genuinely cannot reach", () => {
    const swift = stripSwiftComments(readSource("../../../ios/App/App/SceneDelegate.swift"));
    expect(swift).toMatch(/window\?\.backgroundColor\s*=\s*UIColor\(red:\s*0xF7\s*\/\s*255\.0,\s*green:\s*0xF9\s*\/\s*255\.0,\s*blue:\s*0xF8\s*\/\s*255\.0/);
  });

  it("SceneDelegate.swift does NOT redundantly set the root view controller's own .view background — it IS the webview (loadView does `view = webView`), already covered by capacitor.config.ts's backgroundColor", () => {
    const swift = stripSwiftComments(readSource("../../../ios/App/App/SceneDelegate.swift"));
    expect(swift).not.toMatch(/rootViewController\?\.view\.backgroundColor/);
  });

  it("@capacitor/ios's own CAPBridgeViewController.loadView really does `view = webView` — the assumption the two tests above and the code comments rely on", () => {
    // Not our source, but pinned here: if a future @capacitor/ios upgrade
    // ever changes this, the reasoning above (and the deliberate omission
    // of a redundant .view.backgroundColor line) needs re-checking, not
    // silent staleness.
    const capBridgeSource = readSource("../../../node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgeViewController.swift");
    expect(capBridgeSource).toMatch(/view\s*=\s*webView/);
  });

  it("capacitor.config.ts sets plugins.StatusBar.backgroundColor to the token — fixes the actual top-overscroll cause (the plugin's own status-bar background view, which otherwise defaults to black)", () => {
    const config = stripJsComments(readSource("../../../capacitor.config.ts"));
    const statusBarBlock = config.match(/StatusBar:\s*\{([^}]*)\}/);
    expect(statusBarBlock).not.toBeNull();
    expect(statusBarBlock![1]).toMatch(new RegExp(`backgroundColor:\\s*["']${MOBILE_BG_HEX}["']`));
    expect(statusBarBlock![1]).toMatch(/overlaysWebView:\s*false/);
  });

  it("@capacitor/status-bar's own StatusBarConfig really does default backgroundColor to black — the assumption the StatusBar config fix above relies on", () => {
    const statusBarConfigSource = readSource("../../../node_modules/@capacitor/status-bar/ios/Sources/StatusBarPlugin/StatusBarConfig.swift");
    expect(statusBarConfigSource).toMatch(/backgroundColor:\s*UIColor\s*=\s*\.black/);
  });

  it("normal iOS bounce scrolling is preserved — this fix never sets scrollView.bounces or disables scrolling anywhere", () => {
    const swift = stripSwiftComments(readSource("../../../ios/App/App/SceneDelegate.swift"));
    expect(swift).not.toMatch(/\.bounces\s*=/);
    expect(swift).not.toMatch(/isScrollEnabled\s*=\s*false/);
    const css = stripCssComments(readCss());
    expect(css).not.toMatch(/overscroll-behavior\s*:\s*none/);
  });

  it("plugins.SplashScreen.backgroundColor deliberately uses the AppIcon's own green (#03795E), NOT the general #f7f9f8 token — the splash fills the screen with the icon's own background colour behind its isolated mark, a genuine, intentional exception to \"every layer uses the same token\"", () => {
    const config = stripJsComments(readSource("../../../capacitor.config.ts"));
    const splashBlock = config.match(/SplashScreen:\s*\{([^}]*)\}/);
    expect(splashBlock).not.toBeNull();
    expect(splashBlock![1]).toMatch(/backgroundColor:\s*["']#03795E["']/);
    expect(splashBlock![1]).not.toMatch(new RegExp(`backgroundColor:\\s*["']${MOBILE_BG_HEX}["']`));
    expect(config).not.toMatch(/#f8fbf9/i);
  });
});

describe("iOS launch/splash screen — isolated Linked Leaf mark on the AppIcon's own green, full-screen, centered at 50% width, ~1s minimum cold-launch duration", () => {
  // Regression coverage, second pass. The first pass (an earlier commit on
  // this same branch) replaced the old placeholder with a centered copy of
  // the FULL square AppIcon on the general #f7f9f8 page-background token —
  // which read as a shrunken Home Screen icon tile floating on the wrong
  // colour, not a full-screen brand moment. This pass fixes that: the
  // launch screen's root view is now filled edge-to-edge with the AppIcon's
  // OWN green (#03795E, sampled from AppIcon-512@2x.png itself), and the
  // image view shows a dedicated, separately-generated Splash.imageset
  // asset containing ONLY the white chain-link-and-plant mark with genuine
  // alpha transparency where AppIcon's green background used to be — never
  // a copy of the full AppIcon PNG. AppIcon-512@2x.png itself is never
  // touched by this isolation process (see the checksum-pinning test
  // below).
  const APPICON_GREEN_HEX = "#03795E";

  it("LaunchScreen.storyboard's root view is filled with the exact AppIcon green (#03795E), not the general #f7f9f8 token and not an adaptive systemColor (which would render black in Dark Mode)", () => {
    const storyboard = readSource("../../../ios/App/App/Base.lproj/LaunchScreen.storyboard");
    expect(storyboard).toMatch(
      /<color key="backgroundColor" red="0\.011764705882352941" green="0\.4745098039215686" blue="0\.3686274509803922" alpha="1" colorSpace="custom" customColorSpace="sRGB"\/>/
    );
    expect(storyboard).not.toMatch(/systemColor="systemBackgroundColor"/);
    expect(storyboard).not.toMatch(/0\.96862745098039223/); // the old #f7f9f8 red channel — must be fully gone, not just superseded
  });

  it("LaunchScreen.storyboard's image view uses scaleAspectFit (never stretches or crops) and is centered on both axes", () => {
    const storyboard = readSource("../../../ios/App/App/Base.lproj/LaunchScreen.storyboard");
    expect(storyboard).toMatch(/<imageView[^>]*contentMode="scaleAspectFit"[^>]*image="Splash"/);
    expect(storyboard).toMatch(/firstAttribute="centerX"[^\/]*secondAttribute="centerX"/);
    expect(storyboard).toMatch(/firstAttribute="centerY"[^\/]*secondAttribute="centerY"/);
  });

  it("LaunchScreen.storyboard constrains the image to 50% of the view's width with the isolated mark's real (non-square) 172:175 aspect ratio, matching its 700x688 cropped pixel dimensions", () => {
    const storyboard = readSource("../../../ios/App/App/Base.lproj/LaunchScreen.storyboard");
    expect(storyboard).toMatch(/firstAttribute="width"[^\/]*secondAttribute="width" multiplier="0\.5"/);
    expect(storyboard).toMatch(/firstAttribute="height"[^\/]*secondAttribute="width" multiplier="172:175"/);
    const resourceImage = storyboard.match(/<image name="Splash" width="(\d+)" height="(\d+)"\/>/);
    expect(resourceImage).not.toBeNull();
    const [, width, height] = resourceImage!;
    expect(width).toBe("700");
    expect(height).toBe("688");
  });

  it("LaunchScreen.storyboard has no spinner, label, or animation element — just the one image view", () => {
    const storyboard = readSource("../../../ios/App/App/Base.lproj/LaunchScreen.storyboard");
    expect(storyboard).not.toMatch(/<activityIndicatorView/);
    expect(storyboard).not.toMatch(/<label/);
  });

  it("Splash.imageset's Contents.json still points at the same three filenames cap sync/Xcode expect (only the PNG bytes changed, not the manifest)", () => {
    const contents = JSON.parse(
      readSource("../../../ios/App/App/Assets.xcassets/Splash.imageset/Contents.json")
    );
    const filenames = contents.images.map((img: { filename?: string }) => img.filename).filter(Boolean);
    expect(filenames.sort()).toEqual(
      ["splash-2732x2732-1.png", "splash-2732x2732-2.png", "splash-2732x2732.png"].sort()
    );
  });

  it("capacitor.config.ts's SplashScreen plugin block sets showSpinner: false and backgroundColor to the AppIcon green, explicitly", () => {
    const config = stripJsComments(readSource("../../../capacitor.config.ts"));
    const splashBlock = config.match(/SplashScreen:\s*\{([^}]*)\}/);
    expect(splashBlock).not.toBeNull();
    expect(splashBlock![1]).toMatch(/showSpinner:\s*false/);
    expect(splashBlock![1]).toMatch(new RegExp(`backgroundColor:\\s*["']${APPICON_GREEN_HEX}["']`));
  });

  // PNG structural checks below read each file's raw bytes (not text) and
  // parse the IHDR chunk directly — the first chunk after the fixed 8-byte
  // PNG signature is always length(4)+"IHDR"+width(4)+height(4)+bitDepth(1)
  // +colorType(1)+... per the PNG spec, so this is a stable, dependency-free
  // way to distinguish an opaque (colour type 2, truecolour/RGB) PNG from
  // one with a real alpha channel (colour type 6, truecolour+alpha/RGBA)
  // without needing an image-decoding library in the test suite.
  function readPngIhdr(relativePath: string): { width: number; height: number; bitDepth: number; colorType: number } {
    const buf = readBinarySource(relativePath);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(buf.subarray(0, 8).equals(signature)).toBe(true);
    expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      bitDepth: buf.readUInt8(24),
      colorType: buf.readUInt8(25)
    };
  }

  const PNG_COLOR_TYPE_RGB = 2;
  const PNG_COLOR_TYPE_RGBA = 6;

  it("AppIcon-512@2x.png is still an opaque 1024x1024 RGB PNG (colour type 2, no alpha channel) — the Home Screen icon must never gain transparency", () => {
    const ihdr = readPngIhdr("../../../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
    expect(ihdr.width).toBe(1024);
    expect(ihdr.height).toBe(1024);
    expect(ihdr.colorType).toBe(PNG_COLOR_TYPE_RGB);
  });

  it("AppIcon-512@2x.png's checksum is unchanged from before the splash-isolation pass — the isolation process reads this file but must never write to it", () => {
    const buf = readBinarySource("../../../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
    const hash = createHash("sha256").update(buf).digest("hex");
    expect(hash).toBe("8d90e43ca43f8fca753e21f40bf58faf445cfe3d3d9800310010a1d34011d593");
  });

  it("all three Splash.imageset PNGs are genuinely transparent RGBA (colour type 6, WITH an alpha channel) — distinct from AppIcon's opaque RGB, and identical to each other (universal idiom reuses one image for every scale slot, matching this project's existing AppIcon/Splash convention)", () => {
    const paths = [
      "../../../ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png",
      "../../../ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png",
      "../../../ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png"
    ];
    for (const path of paths) {
      const ihdr = readPngIhdr(path);
      expect(ihdr.width).toBe(700);
      expect(ihdr.height).toBe(688);
      expect(ihdr.colorType).toBe(PNG_COLOR_TYPE_RGBA);
    }
    const hashes = paths.map((path) => createHash("sha256").update(readBinarySource(path)).digest("hex"));
    expect(new Set(hashes).size).toBe(1);
  });

  it("Splash.imageset's PNGs are NOT byte-identical to AppIcon-512@2x.png — the earlier convention of reusing the full icon file for the splash is deliberately gone; the splash is now its own isolated asset", () => {
    const splashHash = createHash("sha256")
      .update(readBinarySource("../../../ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png"))
      .digest("hex");
    const appIconHash = createHash("sha256")
      .update(readBinarySource("../../../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"))
      .digest("hex");
    expect(splashHash).not.toBe(appIconHash);
  });

  it("native/bootstrap.ts enforces a ~1000ms minimum splash-visible floor before calling SplashScreen.hide(), so a fast cold launch doesn't blink the splash away instantly", () => {
    const source = stripJsComments(readSource("../../native/bootstrap.ts"));
    expect(source).toMatch(/MINIMUM_SPLASH_VISIBLE_MS\s*=\s*1000/);
    // The delay must actually be awaited alongside the real bootstrap work
    // (not fired-and-forgotten) and precede the hide() call, otherwise the
    // floor does nothing.
    const hideCallIndex = source.indexOf("SplashScreen.hide()");
    const promiseAllIndex = source.indexOf("Promise.all([");
    expect(hideCallIndex).toBeGreaterThan(-1);
    expect(promiseAllIndex).toBeGreaterThan(-1);
    expect(promiseAllIndex).toBeLessThan(hideCallIndex);
    expect(source).toMatch(/Promise\.all\(\[[\s\S]*delay\(MINIMUM_SPLASH_VISIBLE_MS\)[\s\S]*?\]\)/);
  });

  it("native/bootstrap.ts calls SplashScreen.hide() only once — no second, visually-different splash stage introduced by this change", () => {
    const source = stripJsComments(readSource("../../native/bootstrap.ts"));
    const hideCalls = source.match(/SplashScreen\.hide\(\)/g) ?? [];
    expect(hideCalls.length).toBe(1);
  });
});

describe("native/pushNotifications.ts — never logs the APNs device token itself", () => {
  // Regression test for the release-prep fix: the "registration" listener
  // used to log token.value directly (useful for verifying registration
  // during Stage 2 device testing, but an APNs device token is a
  // credential — it lets a server address push notifications to this
  // specific device — and must never reach a console/log). Confirming
  // it's gone from the SOURCE, not just from a manual read, so a future
  // edit that reintroduces it (e.g. while wiring up the Stage 3 backend)
  // fails a test instead of shipping quietly.
  const source = stripJsComments(readSource("../../native/pushNotifications.ts"));

  it("does not log token.value (or any other property access on the registration token) anywhere", () => {
    expect(source).not.toMatch(/token\.value/);
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)\([^)]*\btoken\b/);
  });

  it("still logs that registration happened, for on-device debugging, just without the token's actual value", () => {
    expect(source).toMatch(/addListener\("registration",[\s\S]{0,120}console\.info/);
  });

  it("native/bootstrap.ts's initializeNativeApp() never calls requestPushPermissionAndRegister() — permission is requested only from an explicit future UI action, never automatically on launch", () => {
    // requestPushPermissionAndRegister is DEFINED in pushNotifications.ts
    // (that file's own declaration line legitimately contains this
    // string, so it isn't asserted against here) but must never be
    // CALLED from app bootstrap.
    const bootstrapSource = stripJsComments(readSource("../../native/bootstrap.ts"));
    expect(bootstrapSource).not.toMatch(/requestPushPermissionAndRegister/);
  });
});
