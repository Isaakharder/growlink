import { Capacitor } from "@capacitor/core";
import type { SupportedStorage } from "@supabase/supabase-js";

// Native builds persist the Supabase auth session via @capacitor/preferences
// (UserDefaults-backed on iOS through Capacitor's native layer) instead of
// supabase-js's own default, which is window.localStorage. @supabase/supabase-js
// accepts any object implementing this async get/set/removeItem shape as
// `auth.storage` (see supabase.ts) — this is the same pattern Supabase's own
// React Native guide uses with AsyncStorage.
//
// Returns undefined on the web build so createClient() falls back to its
// normal localStorage-backed default, unchanged from before this file
// existed.
export function getNativeAuthStorage(): SupportedStorage | undefined {
  if (!Capacitor.isNativePlatform()) return undefined;

  return {
    async getItem(key: string) {
      const { Preferences } = await import("@capacitor/preferences");
      const { value } = await Preferences.get({ key });
      return value;
    },
    async setItem(key: string, value: string) {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key, value });
    },
    async removeItem(key: string) {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.remove({ key });
    }
  };
}
