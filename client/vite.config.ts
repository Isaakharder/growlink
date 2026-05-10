import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

function rewriteMobileEntry(url?: string) {
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
  const applyRewrite = (req: { url?: string }) => {
    req.url = rewriteMobileEntry(req.url);
  };

  return {
    name: "mobile-html-fallback",
    configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => {
        applyRewrite(req);
        next();
      });
    },
    configurePreviewServer(server: { middlewares: { use: (handler: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
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
      injectRegister: "auto",
      manifest: false,
      includeAssets: [
        "favicon.svg",
        "apple-touch-icon.svg",
        "pwa-192x192.svg",
        "pwa-512x512.svg",
        "pwa-maskable.svg"
      ],
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
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
