import { supabase } from "../config/supabase";

export type CsvSizeSettings = {
  ignoredSizeLabels: string[];
  sizeAliases: Record<string, string>;
};

const EMPTY_SETTINGS: CsvSizeSettings = { ignoredSizeLabels: [], sizeAliases: {} };

export async function fetchCsvSizeSettings(organizationId: string): Promise<CsvSizeSettings> {
  const { data } = await supabase
    .from("daily_yield_bin_settings")
    .select("csv_size_settings")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const raw = data?.csv_size_settings as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SETTINGS;

  const ignoredSizeLabels: string[] = Array.isArray(raw.ignoredSizeLabels)
    ? (raw.ignoredSizeLabels as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const sizeAliases: Record<string, string> = {};
  const rawAliases = raw.sizeAliases;
  if (rawAliases && typeof rawAliases === "object" && !Array.isArray(rawAliases)) {
    for (const [k, v] of Object.entries(rawAliases as Record<string, unknown>)) {
      if (typeof v === "string") sizeAliases[k] = v;
    }
  }

  return { ignoredSizeLabels, sizeAliases };
}
