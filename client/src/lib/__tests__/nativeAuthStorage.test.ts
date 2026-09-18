import { afterEach, describe, expect, it, vi } from "vitest";

const nativeState = vi.hoisted(() => ({ isNative: false }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => nativeState.isNative } }));

const get = vi.fn();
const set = vi.fn();
const remove = vi.fn();
vi.mock("@aparajita/capacitor-secure-storage", () => ({
  SecureStorage: {
    get: (...a: unknown[]) => get(...a),
    set: (...a: unknown[]) => set(...a),
    remove: (...a: unknown[]) => remove(...a)
  },
  KeychainAccess: { whenUnlockedThisDeviceOnly: "whenUnlockedThisDeviceOnly" }
}));

const preferencesGet = vi.fn();
const preferencesSet = vi.fn();
const preferencesRemove = vi.fn();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: (...a: unknown[]) => preferencesGet(...a),
    set: (...a: unknown[]) => preferencesSet(...a),
    remove: (...a: unknown[]) => preferencesRemove(...a)
  }
}));

import { getNativeAuthStorage } from "../nativeAuthStorage";

const SESSION_KEY = "sb-revkaepkvgfeumtykibq-auth-token";

describe("nativeAuthStorage — native build (Keychain via @aparajita/capacitor-secure-storage)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    nativeState.isNative = false;
  });

  it("writes a session to the Keychain with device-only accessibility and sync disabled", async () => {
    nativeState.isNative = true;
    set.mockResolvedValue(undefined);
    const storage = getNativeAuthStorage()!;

    await storage.setItem(SESSION_KEY, "the-serialized-session");

    expect(set).toHaveBeenCalledWith(SESSION_KEY, "the-serialized-session", false, false, "whenUnlockedThisDeviceOnly");
    // Never synchronized through iCloud Keychain.
    expect(set.mock.calls[0][3]).toBe(false);
  });

  it("reads a session back from the Keychain", async () => {
    nativeState.isNative = true;
    get.mockResolvedValue("the-serialized-session");
    const storage = getNativeAuthStorage()!;

    const value = await storage.getItem(SESSION_KEY);

    expect(value).toBe("the-serialized-session");
    expect(get).toHaveBeenCalledWith(SESSION_KEY, false, false);
  });

  it("returns null when no session is stored, rather than throwing", async () => {
    nativeState.isNative = true;
    get.mockResolvedValue(null);
    const storage = getNativeAuthStorage()!;

    expect(await storage.getItem(SESSION_KEY)).toBeNull();
  });

  it("removes the session from the Keychain on logout", async () => {
    nativeState.isNative = true;
    remove.mockResolvedValue(true);
    const storage = getNativeAuthStorage()!;

    await storage.removeItem(SESSION_KEY);

    expect(remove).toHaveBeenCalledWith(SESSION_KEY, false);
  });

  it("never touches Capacitor Preferences for any operation — no fallback when secure storage fails", async () => {
    nativeState.isNative = true;
    get.mockRejectedValue(new Error("Keychain error -34018"));
    set.mockRejectedValue(new Error("Keychain error -34018"));
    remove.mockRejectedValue(new Error("Keychain error -34018"));
    const storage = getNativeAuthStorage()!;

    await expect(storage.getItem(SESSION_KEY)).rejects.toThrow();
    await expect(storage.setItem(SESSION_KEY, "value")).rejects.toThrow();
    await expect(storage.removeItem(SESSION_KEY)).rejects.toThrow();

    expect(preferencesGet).not.toHaveBeenCalled();
    expect(preferencesSet).not.toHaveBeenCalled();
    expect(preferencesRemove).not.toHaveBeenCalled();
  });

  it("a failed write rejects with a generic error that never contains the token value", async () => {
    nativeState.isNative = true;
    const leakyToken = "eyJhbGciOi.SUPER-SECRET-ACCESS-TOKEN.abc123";
    // Simulates a native error that (worst case) echoes its input — the
    // adapter must not forward it verbatim regardless.
    set.mockRejectedValue(new Error(`Keychain write failed for value ${leakyToken}`));
    const storage = getNativeAuthStorage()!;

    await expect(storage.setItem(SESSION_KEY, leakyToken)).rejects.toThrow();
    try {
      await storage.setItem(SESSION_KEY, leakyToken);
    } catch (err) {
      expect(String(err)).not.toContain(leakyToken);
      expect(String(err)).not.toContain("SUPER-SECRET-ACCESS-TOKEN");
    }
  });

  it("a failed read rejects with a generic error that never contains stored content", async () => {
    nativeState.isNative = true;
    get.mockRejectedValue(new Error("underlying OS error referencing some-secret-value"));
    const storage = getNativeAuthStorage()!;

    try {
      await storage.getItem(SESSION_KEY);
      throw new Error("expected getItem to reject");
    } catch (err) {
      expect(String(err)).not.toContain("some-secret-value");
    }
  });
});

describe("nativeAuthStorage — web/PWA build", () => {
  afterEach(() => {
    vi.clearAllMocks();
    nativeState.isNative = false;
  });

  it("returns undefined so supabase-js falls back to its own default (localStorage) storage, unchanged", () => {
    nativeState.isNative = false;
    expect(getNativeAuthStorage()).toBeUndefined();
  });

  it("never touches the Keychain plugin or Preferences on the web build", () => {
    nativeState.isNative = false;
    getNativeAuthStorage();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(preferencesGet).not.toHaveBeenCalled();
  });
});
