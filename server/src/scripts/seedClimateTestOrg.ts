import "dotenv/config";
import { createHash } from "crypto";
import { supabase } from "../config/supabase";

// One-off helper: creates a throwaway organization + upload key for testing
// the GrowLink Climate Agent end to end. Safe to delete after testing --
// see DELETE statements printed at the end.
async function main() {
  const rawKey = process.argv[2];
  if (!rawKey) {
    throw new Error("Usage: tsx src/scripts/seedClimateTestOrg.ts <raw-upload-key>");
  }
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .insert({ name: "Climate Agent Test" })
    .select("id, name")
    .single();

  if (orgError || !org) {
    throw new Error(`Failed to create test organization: ${orgError?.message}`);
  }

  const { data: key, error: keyError } = await supabase
    .from("organization_upload_keys")
    .insert({
      organization_id: org.id,
      key_hash: keyHash,
      label: "Climate Agent Test Key",
      status: "active",
    })
    .select("id")
    .single();

  if (keyError || !key) {
    throw new Error(`Failed to create upload key: ${keyError?.message}`);
  }

  console.log(`organization_id=${org.id}`);
  console.log(`upload_key_id=${key.id}`);
  console.log("\nTo clean up later:");
  console.log(`  DELETE FROM organization_upload_keys WHERE id = '${key.id}';`);
  console.log(`  DELETE FROM organizations WHERE id = '${org.id}'; -- cascades climate_imports/climate_readings`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
