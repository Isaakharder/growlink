import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Separate from vite.config.ts (which wires up the PWA plugin and the
// dual index.html/mobile.html build entries — neither is relevant to, or
// safe to run under, the unit test environment).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    css: false
  }
});
