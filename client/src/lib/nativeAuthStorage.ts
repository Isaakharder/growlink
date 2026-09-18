import { Capacitor } from "@capacitor/core";
import type { SupportedStorage } from "@supabase/supabase-js";

// Native builds persist the Supabase auth session (access token, refresh
// token, the whole serialized session supabase-js hands to a storage
// adapter) through Apple Keychain Services, via
// @aparajita/capacitor-secure-storage — NOT @capacitor/preferences.
// Preferences is a thin wrapper over UserDefaults, which is plain,
// unencrypted, sandboxed-but-not-secure storage; it must never hold
// authentication tokens. (Preferences remains fine elsewhere in the app
// for non-sensitive flags/settings — just not here.)
//
// @supabase/supabase-js accepts any object implementing this async
// get/set/removeItem shape as `auth.storage` (see supabase.ts) — this is
// the same pattern Supabase's own React Native guide uses with
// AsyncStorage, just backed by the Keychain instead.
//
// Every call explicitly passes sync: false and (on write) access:
// whenUnlockedThisDeviceOnly, rather than relying on the plugin's global
// setSynchronize()/setDefaultKeychainAccess() having already run — so
// there is no call-ordering window where a write could land with the
// wrong accessibility class or get handed to iCloud Keychain:
//   - sync: false — GrowLink auth tokens are never synchronized through
//     iCloud Keychain. Each device authenticates and stores its own
//     session independently.
//   - access: whenUnlockedThisDeviceOnly — the item is readable only
//     while the device is unlocked, never leaves this device (no iCloud,
//     no backup restore to another device), and never migrates via
//     iTunes/Finder encrypted backups either — the standard accessibility
//     class for an authenticated business app's session credentials.
//
// Returns undefined on the web build so createClient() falls back to its
// normal localStorage-backed default, unchanged from before this file
// existed.
export function getNativeAuthStorage(): SupportedStorage | undefined {
  if (!Capacitor.isNativePlatform()) return undefined;

  return {
    async getItem(key: string) {
      const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
      try {
        const value = await SecureStorage.get(key, false, false);
        return value === null ? null : String(value);
      } catch {
        // Deliberately no fallback to any other storage (Preferences or
        // otherwise) — a read failure means "no session", not "try
        // somewhere less secure." Never logs the caught error: on some
        // OS error paths it can carry OS-level context we don't need to
        // risk echoing, and it never carries the token value regardless,
        // but the safe rule is simpler than "except when."
        throw new Error("Native secure storage read failed.");
      }
    },
    async setItem(key: string, value: string) {
      const { SecureStorage, KeychainAccess } = await import("@aparajita/capacitor-secure-storage");
      try {
        await SecureStorage.set(key, value, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
      } catch {
        throw new Error("Native secure storage write failed.");
      }
    },
    async removeItem(key: string) {
      const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
      try {
        await SecureStorage.remove(key, false);
      } catch {
        throw new Error("Native secure storage remove failed.");
      }
    }
  };
}
