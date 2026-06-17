import "dotenv/config";
import { supabase } from "../config/supabase";

async function main() {
  const orgId = process.argv[2];
  if (!orgId) throw new Error("Usage: tsx src/scripts/checkClimateCounts.ts <organization_id>");

  const { count: importCount, error: importErr } = await supabase
    .from("climate_imports")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (importErr) throw importErr;

  const { count: readingCount, error: readingErr } = await supabase
    .from("climate_readings")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (readingErr) throw readingErr;

  const { data: byMetric, error: metricErr } = await supabase
    .from("climate_readings")
    .select("metric_name")
    .eq("organization_id", orgId);
  if (metricErr) throw metricErr;

  const counts: Record<string, number> = {};
  for (const row of byMetric ?? []) {
    counts[row.metric_name] = (counts[row.metric_name] ?? 0) + 1;
  }

  console.log("climate_imports:", importCount);
  console.log("climate_readings:", readingCount);
  console.log("by metric:", counts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
