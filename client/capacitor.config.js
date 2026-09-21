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
    // Overscroll/background fix: GrowLink Mobile's own page background is
    // #f7f9f8 — the flat colour .mobile-layout (src/index.css) and :root
    // both already use. Left unset, Capacitor falls back to
    // UIColor.systemBackground for the WKWebView AND its internal
    // scrollView (see @capacitor/ios's CAPBridgeViewController.swift,
    // prepareWebView) — systemBackground is a dynamic color that renders
    // black under system Dark Mode, which is exactly the "black native
    // background" a rubber-band overscroll (top or bottom) revealed. This
    // is the one config layer Capacitor's own supported configuration DOES
    // cover; it does NOT cover the view controller's own view or the
    // window, which have no config-file equivalent — see
    // ios/App/App/SceneDelegate.swift for the matching native Swift fix
    // for those two.
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
            backgroundColor: "#f8fbf9"
        }
    }
};
export default config;
