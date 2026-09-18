import { createClient } from "@supabase/supabase-js";
import { getNativeAuthStorage } from "./nativeAuthStorage";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  );
}

const nativeStorage = getNativeAuthStorage();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: nativeStorage ? { storage: nativeStorage } : undefined
});
