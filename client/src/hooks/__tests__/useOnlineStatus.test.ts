import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.hoisted: Capacitor.isNativePlatform() must be a live, per-test
// toggle, but the hoisted vi.mock factory below runs before any plain
// top-level `let` in this file would be initialized.
const nativeState = vi.hoisted(() => ({ isNative: false }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => nativeState.isNative } }));

const getStatus = vi.fn();
const addListener = vi.fn();
vi.mock("@capacitor/network", () => ({
  Network: {
    getStatus: (...a: unknown[]) => getStatus(...a),
    addListener: (...a: unknown[]) => addListener(...a)
  }
}));

import { useOnlineStatus } from "../useOnlineStatus";

describe("useOnlineStatus — web build (navigator.onLine + online/offline events)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    nativeState.isNative = false;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  it("reflects navigator.onLine on mount", () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current.isOnline).toBe(true);
  });

  it("flips to offline/online as the browser fires the corresponding window events", () => {
    const { result } = renderHook(() => useOnlineStatus());

    act(() => window.dispatchEvent(new Event("offline")));
    expect(result.current.isOnline).toBe(false);

    act(() => window.dispatchEvent(new Event("online")));
    expect(result.current.isOnline).toBe(true);
  });

  it("never touches @capacitor/network on the web build", () => {
    renderHook(() => useOnlineStatus());
    expect(getStatus).not.toHaveBeenCalled();
  });
});

describe("useOnlineStatus — native iOS build (@capacitor/network)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    nativeState.isNative = false;
  });

  it("reads the real OS-level status via Network.getStatus() on mount, not navigator.onLine", async () => {
    nativeState.isNative = true;
    getStatus.mockResolvedValue({ connected: false });
    addListener.mockResolvedValue({ remove: vi.fn() });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    const { result } = renderHook(() => useOnlineStatus());

    await waitFor(() => expect(result.current.isOnline).toBe(false));
  });

  it("updates from the networkStatusChange listener (reconnect case)", async () => {
    nativeState.isNative = true;
    getStatus.mockResolvedValue({ connected: false });
    let statusChangeHandler: ((status: { connected: boolean }) => void) | undefined;
    addListener.mockImplementation((_event: string, handler: (status: { connected: boolean }) => void) => {
      statusChangeHandler = handler;
      return Promise.resolve({ remove: vi.fn() });
    });

    const { result } = renderHook(() => useOnlineStatus());
    await waitFor(() => expect(result.current.isOnline).toBe(false));

    act(() => statusChangeHandler?.({ connected: true }));
    await waitFor(() => expect(result.current.isOnline).toBe(true));
  });
});
