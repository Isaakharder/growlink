import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
    plugins: [
        react(),
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
    server: {
        port: 5173
    }
});
