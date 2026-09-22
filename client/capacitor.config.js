// appId ("com.linklogictechnologies.growlink") and appName pending the
// user's own confirmation that the bundle ID is available/appropriate in
// App Store Connect before it's treated as permanent — see the Stage 1
// report. webDir points at the dist-ios/ produced by `npm run build:ios`
// (vite.ios.config.ts), never dist/ (the Railway web/PWA build's output).
const config = {
    appId: "com.linklogictechnologies.growlink",
    appName: "GrowLink Mobile",
    webDir: "dist-ios",
    // Security fix: Capacitor's own default ("debug") logs native bridge
    // calls — including plugin call arguments/results, which is how a first
    // physical-device Debug build printed the full Supabase session (access
    // token included) returned from SecureStorage's native getItem into the
    // Xcode console. "none" disables that logging unconditionally, in every
    // build configuration (Debug AND Release) — Capacitor reads this one
    // value from the SAME capacitor.config.json bundled into the app in
    // both configurations; there is no separate Debug/Release config file,
    // so there is nothing to solve per-configuration here (Xcode's Debug vs
    // Release build settings never override it — see
    // ios/App/App.xcodeproj/project.pbxproj, which has no logging-related
    // build setting at all). Do not rely on Capacitor's per-platform
    // `ios.loggingBehavior` override instead of this — it only overrides
    // this value when explicitly set, so leaving this one authoritative is
    // what keeps there being a single source of truth.
    loggingBehavior: "none",
    // Overscroll/background fix (bottom half): GrowLink Mobile's own page
    // background is #f7f9f8 — the flat colour .mobile-layout
    // (src/index.css) and :root both already use. Left unset, Capacitor
    // falls back to UIColor.systemBackground for the WKWebView AND its
    // internal scrollView (see @capacitor/ios's CAPBridgeViewController
    // .swift, prepareWebView) — systemBackground renders black under
    // system Dark Mode. CAPBridgeViewController.loadView() does
    // `view = webView`, i.e. the view controller's OWN .view IS the
    // WKWebView — there is no separate container view to also color, this
    // one value covers both. (An earlier version of this fix set
    // window?.rootViewController?.view.backgroundColor in
    // SceneDelegate.swift believing that reached a distinct view; it does
    // not — accessing .view there just forces this same webview to load
    // early. window?.backgroundColor there is still worth keeping, as a
    // fallback for the plain UIWindow background itself, a genuinely
    // separate layer.)
    backgroundColor: "#f7f9f8",
    ios: {
        // Leaves the default `capacitor` scheme (origin capacitor://localhost)
        // rather than overriding it to plain http — CORS/auth on the server
        // side is audited and narrowly opened for that exact origin (see
        // server/src/app.ts's CORS_ORIGINS), not for a broader one.
        contentInset: "automatic"
    },
    plugins: {
        SplashScreen: {
            // Hidden explicitly once the app has bootstrapped (see
            // native/bootstrap.ts's SplashScreen.hide() call) rather than on a
            // fixed timer, so a slow first load never flashes a bare white
            // screen before Mobile Home is ready to render.
            launchAutoHide: false,
            // #f7f9f8 — the same GrowLink Mobile page-background token used
            // everywhere else natively (top-level backgroundColor above,
            // plugins.StatusBar.backgroundColor below, body.native-shell in
            // src/index.css, SceneDelegate.swift's window fallback). Was
            // #f8fbf9 — a slightly different value, noted as a pre-existing
            // inconsistency back when the overscroll fix first established
            // #f7f9f8 as the token; reconciled here so every native surface
            // uses the exact same colour, not two visually-near-identical ones.
            backgroundColor: "#f7f9f8"
        },
        // Overscroll/background fix (top half — the actual cause of the
        // black TOP overscroll the WKWebView/window fix above didn't reach):
        // native/statusBar.ts calls StatusBar.setOverlaysWebView({overlay:
        // false}), which makes @capacitor/status-bar's native StatusBar.swift
        // create a SEPARATE UIView ("backgroundView") covering exactly the
        // status-bar strip, added as a sibling of the webview directly under
        // the window (bridge.webView?.superview?.addSubview(...)) — neither
        // the webview's nor the window's background paints there at all once
        // overlaysWebView is false. That view's color comes from this SAME
        // plugin's own backgroundColor property, which defaults to
        // UIColor.black (StatusBarConfig.swift) and is only ever updated by
        // an explicit StatusBar.setBackgroundColor() call — which
        // native/statusBar.ts never made. Setting it here means
        // StatusBarPlugin.load() bakes in the correct colour from app launch
        // (before any JS runs), rather than depending on call-ordering
        // between this config and the imperative setOverlaysWebView call.
        // overlaysWebView/style are also set here, redundantly with
        // native/statusBar.ts's imperative calls, so the correct values are
        // in place from the very first `capacitorViewDidAppear` — matching
        // Style.Light there (dark icons; the "LIGHT" string, not lowercase
        // "light" — StatusBar.swift lowercases before comparing either way,
        // but the enum's own casing is what native/statusBar.ts sends).
        StatusBar: {
            backgroundColor: "#f7f9f8",
            overlaysWebView: false,
            style: "LIGHT"
        }
    }
};
export default config;
