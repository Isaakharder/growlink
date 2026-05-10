import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
function rewriteMobileEntry(url) {
    if (!url) {
        return url;
    }
    const [pathname, search = ""] = url.split("?");
    // Serve the dedicated mobile shell for /mobile and nested routes.
    if (/^\/mobile(?:\/.*)?$/.test(pathname) && !pathname.includes(".")) {
        return `/mobile.html${search ? `?${search}` : ""}`;
    }
    return url;
}
function mobileHtmlFallbackPlugin() {
    const applyRewrite = (req) => {
        req.url = rewriteMobileEntry(req.url);
    };
    return {
        name: "mobile-html-fallback",
        configureServer(server) {
            server.middlewares.use((req, _res, next) => {
                applyRewrite(req);
                next();
            });
        },
        configurePreviewServer(server) {
            server.middlewares.use((req, _res, next) => {
                applyRewrite(req);
                next();
            });
        }
    };
}
export default defineConfig({
    plugins: [
        react(),
        mobileHtmlFallbackPlugin(),
        VitePWA({
            registerType: "autoUpdate",
            // Registration is handled explicitly in main.tsx via registerSW()
            injectRegister: false,
            manifest: false,
            includeAssets: [
                "favicon.svg",
                "apple-touch-icon.svg",
                "pwa-192x192.svg",
                "pwa-512x512.svg",
                "pwa-maskable.svg"
            ],
            workbox: {
                // Precache only static build artifacts — no org/user data lives here
                globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
                // Serve index.html as the SPA shell for desktop navigation fallback.
                // The denylist ensures /mobile/* is never served index.html by the SW;
                // those requests fall through to the network so the server returns the
                // correct mobile.html (preserving the mobile PWA's manifest and shell).
                navigateFallback: "index.html",
                navigateFallbackDenylist: [/^\/mobile/],
                runtimeCaching: [
                    // Same-origin API — always network, never cache
                    {
                        urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
                        handler: "NetworkOnly",
                        method: "GET"
                    },
                    // Supabase auth and REST API — always network, never cache.
                    // These responses contain session tokens and org-scoped data.
                    {
                        urlPattern: ({ url }) => url.hostname.endsWith(".supabase.co"),
                        handler: "NetworkOnly",
                        method: "GET"
                    },
                    // Belt-and-suspenders: any authenticated GET request must not be
                    // cached regardless of URL, preventing stale org data on re-login.
                    {
                        urlPattern: ({ request }) => request.headers.has("Authorization"),
                        handler: "NetworkOnly",
                        method: "GET"
                    }
                ]
            },
            devOptions: {
                enabled: false
            }
        })
    ],
    build: {
        rollupOptions: {
            input: {
                main: "index.html",
                mobile: "mobile.html"
            }
        }
    },
    server: {
        port: 5173
    }
});
