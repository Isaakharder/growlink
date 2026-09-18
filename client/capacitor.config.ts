import type { CapacitorConfig } from "@capacitor/cli";

// appId ("com.linklogictechnologies.growlink") and appName pending the
// user's own confirmation that the bundle ID is available/appropriate in
// App Store Connect before it's treated as permanent — see the Stage 1
// report. webDir points at the dist-ios/ produced by `npm run build:ios`
// (vite.ios.config.ts), never dist/ (the Railway web/PWA build's output).
const config: CapacitorConfig = {
  appId: "com.linklogictechnologies.growlink",
  appName: "GrowLink Mobile",
  webDir: "dist-ios",
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
