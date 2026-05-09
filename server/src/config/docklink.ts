import { createClient } from "@supabase/supabase-js";

const DOCKLINK_URL = process.env.DOCKLINK_SUPABASE_URL;
const DOCKLINK_KEY = process.env.DOCKLINK_SUPABASE_SERVICE_ROLE_KEY;

if (!DOCKLINK_URL || !DOCKLINK_KEY) {
  console.warn("DockLink Supabase configuration missing. DockLink sync will not be available.");
}

export const docklinkSupabase = DOCKLINK_URL && DOCKLINK_KEY
  ? createClient(DOCKLINK_URL, DOCKLINK_KEY)
  : null;

export function isDocklinkConfigured(): boolean {
  return docklinkSupabase !== null;
}
