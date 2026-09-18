import { lazy } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LazyRoute } from "../LazyRoute";

function Loaded() {
  return <div>Loaded Content</div>;
}

describe("LazyRoute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a GrowLink-styled loading state while the chunk is pending, then renders it once resolved", async () => {
    const LazyLoaded = lazy(
      () =>
        new Promise<{ default: typeof Loaded }>((resolve) => {
          setTimeout(() => resolve({ default: Loaded }), 10);
        })
    );

    render(
      <LazyRoute>
        <LazyLoaded />
      </LazyRoute>
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("Loaded Content")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows a usable error state with a reload action instead of a blank screen when the chunk import fails", async () => {
    // Suppress React's expected error-boundary console noise for this case.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const FailingLazy = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));

    render(
      <LazyRoute>
        <FailingLazy />
      </LazyRoute>
    );

    expect(await screen.findByText(/couldn't be loaded/i)).toBeInTheDocument();
    const reloadButton = screen.getByRole("button", { name: "Reload" });
    expect(reloadButton).toBeInTheDocument();

    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", { value: { reload: reloadSpy }, writable: true });
    reloadButton.click();
    expect(reloadSpy).toHaveBeenCalled();
  });
});
