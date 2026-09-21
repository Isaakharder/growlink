import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Dedicated build for the native iOS shell (Capacitor). Deliberately
// separate from vite.config.ts rather than a mode/flag on it:
//   - Single entry (native.html -> src/main.native.tsx) instead of the web
//     config's two (index.html, mobile.html) — the native bundle can never
//     contain desktop routes or the web-only mobile-vs-desktop split logic.
//   - No VitePWA plugin at all, so no service worker / precache manifest is
//     ever generated into dist-ios — "no PWA service worker natively" is
//     enforced at the build level, not just by main.native.tsx skipping
//     registerSW().
//   - Separate outDir (dist-ios) and emptyOutDir — this build and
//     `npm run build` (-> dist/, the Railway web/PWA deploy) can run
//     back-to-back, or in either order, without one touching the other's
//     output directory. See scripts/__tests__ for a test asserting this.
//
// `--mode ios` (see package.json's build:ios script) loads .env.ios
// automatically, which points this build at the production API/Supabase
// URLs — main.native.tsx renders router/nativeRoutes.tsx, which mounts
// the shared mobile route tree at "/mobile", the same path the web build
// uses (see config/platform.ts).
export default defineConfig({
    plugins: [react()],
    build: {
        outDir: "dist-ios",
        emptyOutDir: true,
        rollupOptions: {
            input: {
                app: "native.html"
            }
        }
    }
});
