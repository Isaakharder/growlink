import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";

// Separate from vite.config.ts (which wires up the PWA plugin and the
// dual index.html/mobile.html build entries — neither is relevant to, or
// safe to run under, the unit test environment).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    css: false,
    // pestChemicalCalc.test.ts deliberately uses node:test, not Vitest
    // (see its own header comment — run it via `npm run test:node`
    // instead). Left in Vitest's default include glob, it collects fine
    // as a module but registers zero Vitest tests, which Vitest reports
    // as a hard "No test suite found in file" error rather than 0 tests
    // passed — excluding it by exact path is what CONFIGURING the test
    // command to skip it (rather than renaming/moving the file, or
    // touching anything the file itself asserts) looks like. Spreads
    // Vitest's own configDefaults.exclude rather than replacing it, so
    // node_modules/dist/etc. stay excluded same as before this existed.
    exclude: [...configDefaults.exclude, "src/utils/__tests__/pestChemicalCalc.test.ts"]
  }
});
