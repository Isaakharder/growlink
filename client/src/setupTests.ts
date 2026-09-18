import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest.config.ts doesn't enable `test.globals`, so @testing-library/react's
// own auto-cleanup registration (which relies on detecting a global
// afterEach) doesn't fire — without this, each test's rendered DOM would
// pile up across tests within the same file.
afterEach(() => {
  cleanup();
});
