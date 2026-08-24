// Tests for changing an existing upload key's data_source_type
// (Administrator-only). Split across two layers:
//
// 1. Real HTTP requests against the actual Express app, proving the route
//    is genuinely gated by requireAdminUser (a request with no/invalid
//    auth is rejected) — this is the permission-enforcement proof.
// 2. Direct calls to the exported updateUploadKeyDataSourceType function
//    for the business logic (validation, the csv_template active-template
//    gate, the audit fields, and — critically — that the raw key is never
//    touched or exposed), since requireAdminUser itself needs a real
//    Supabase-issued JWT for a user id baked into ADMIN_USER_IDS at
//    process startup, which cannot be fabricated in a test.
//
// Every test creates its own throwaway upload key/template and cleans up
// afterward; no real data is touched.
import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { app } from "../../app";
import { supabase } from "../../config/supabase";
import {
  updateUploadKeyDataSourceType,
  UploadKeyValidationError,
  UploadKeyNotFoundError,
  UploadKeyNoActiveTemplateError
} from "../adminUploadKeys";
import { createTemplate, parseTemplateWriteBody } from "../csvMappingTemplates";
import { parseCsvGridFromBuffer } from "../../utils/csvGridParser";

const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";
const TEST_ADMIN_ID = "00000000-0000-0000-0000-0000000000dd";

let server: Server;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

async function createTestUploadKey(dataSourceType: string, organizationId = DENVA_ORG_ID) {
  const rawKey = `test_${randomUUID()}`;
  const { data, error } = await supabase
    .from("organization_upload_keys")
    .insert({
      organization_id: organizationId,
      key_hash: hashKey(rawKey),
      label: `admin-dst-test-${randomUUID()}`,
      status: "active",
      data_source_type: dataSourceType
    })
    .select("id, key_hash")
    .single();
  if (error) throw error;
  return { id: data!.id as string, keyHash: data!.key_hash as string };
}

async function deleteTestUploadKey(id: string) {
  await supabase.from("agent_pending_imports").delete().eq("upload_key_id", id);
  await supabase.from("import_source_templates").delete().eq("upload_key_id", id);
  await supabase.from("organization_upload_keys").delete().eq("id", id);
}

async function cleanupTemplateGroup(templateGroupId: string) {
  await supabase.from("csv_mapping_templates").delete().eq("template_group_id", templateGroupId);
}

/** Runs every cleanup step regardless of whether an earlier one throws — see agentPdfImportCsvTemplate.integration.test.ts for why this matters. */
async function cleanupAll(...tasks: Array<() => PromiseLike<unknown>>): Promise<void> {
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      console.warn("[test cleanup] a cleanup step failed (continuing with the rest):", err instanceof Error ? err.message : err);
    }
  }
}

async function seedActiveTemplate(organizationId: string) {
  const marker = randomUUID();
  const csvText = `Market,Size,Kg\nClass 1,SM,5\n`;
  const { columnCount, rowCount, delimiter } = parseCsvGridFromBuffer(Buffer.from(csvText, "utf-8"));

  const { data: insertedSource, error: insertErr } = await supabase
    .from("csv_import_source_files")
    .insert({
      organization_id: organizationId,
      file_hash: `admin-dst-test-${marker}`,
      filename: `admin-dst-test-${marker}.csv`,
      raw_text: csvText,
      row_count: rowCount,
      column_count: columnCount,
      delimiter
    })
    .select("id")
    .single();
  if (insertErr) throw insertErr;

  const body = parseTemplateWriteBody({
    name: `Admin DST Test Template ${marker}`,
    sourceFileId: insertedSource!.id,
    delimiter: ",",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    columnMappings: [
      { columnIndex: 0, field: "market_grade" },
      { columnIndex: 1, field: "size_label" },
      { columnIndex: 2, field: "size_weight_kg" }
    ],
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "create", newSizeName: `AdminDstTestSize-${marker}` }]
  });
  const template = await createTemplate(organizationId, TEST_ADMIN_ID, body);

  return {
    template,
    cleanup: async () => {
      await cleanupTemplateGroup(template.template_group_id);
      await supabase.from("csv_import_source_files").delete().eq("id", insertedSource!.id);
    }
  };
}

// ---------------------------------------------------------------------------
// Permission enforcement — real HTTP, no fabricated admin session.
// ---------------------------------------------------------------------------

test("PATCH data-source-type: no Authorization header is rejected (401), proving the route is gated by requireAdminUser", async () => {
  const key = await createTestUploadKey("flowmaster");
  try {
    const res = await fetch(`${baseUrl}/api/admin/upload-keys/${key.id}/data-source-type`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataSourceType: "csv_template" })
    });
    assert.equal(res.status, 401);

    const { data: unchanged } = await supabase.from("organization_upload_keys").select("data_source_type").eq("id", key.id).single();
    assert.equal(unchanged?.data_source_type, "flowmaster");
  } finally {
    await deleteTestUploadKey(key.id);
  }
});

test("PATCH data-source-type: an invalid/garbage bearer token is rejected (401), not silently treated as authenticated", async () => {
  const key = await createTestUploadKey("flowmaster");
  try {
    const res = await fetch(`${baseUrl}/api/admin/upload-keys/${key.id}/data-source-type`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ dataSourceType: "csv_template" })
    });
    assert.equal(res.status, 401);
  } finally {
    await deleteTestUploadKey(key.id);
  }
});

// ---------------------------------------------------------------------------
// Business logic — direct calls (see file header for why).
// ---------------------------------------------------------------------------

test("updateUploadKeyDataSourceType: rejects an invalid dataSourceType value", async () => {
  const key = await createTestUploadKey("flowmaster");
  try {
    await assert.rejects(() => updateUploadKeyDataSourceType(key.id, "not_a_real_type", TEST_ADMIN_ID), UploadKeyValidationError);
  } finally {
    await deleteTestUploadKey(key.id);
  }
});

test("updateUploadKeyDataSourceType: rejects a nonexistent key id", async () => {
  await assert.rejects(() => updateUploadKeyDataSourceType(randomUUID(), "generic_csv", TEST_ADMIN_ID), UploadKeyNotFoundError);
});

test("updateUploadKeyDataSourceType: allows flowmaster <-> generic_csv freely (no template gate)", async () => {
  const key = await createTestUploadKey("flowmaster");
  try {
    const result = await updateUploadKeyDataSourceType(key.id, "generic_csv", TEST_ADMIN_ID);
    assert.equal(result.dataSourceType, "generic_csv");
    assert.equal(result.unchanged, false);
  } finally {
    await deleteTestUploadKey(key.id);
  }
});

test("updateUploadKeyDataSourceType: a no-op change (same type) is reported as unchanged and doesn't touch updated_at", async () => {
  const key = await createTestUploadKey("flowmaster");
  try {
    const result = await updateUploadKeyDataSourceType(key.id, "flowmaster", TEST_ADMIN_ID);
    assert.equal(result.unchanged, true);
    assert.equal(result.updatedAt, null);
  } finally {
    await deleteTestUploadKey(key.id);
  }
});

test("updateUploadKeyDataSourceType: csv_template is blocked when the organization has no active template", async () => {
  const key = await createTestUploadKey("flowmaster");
  try {
    await assert.rejects(async () => {
      try {
        await updateUploadKeyDataSourceType(key.id, "csv_template", TEST_ADMIN_ID);
      } catch (err) {
        assert.ok(err instanceof UploadKeyNoActiveTemplateError);
        assert.equal((err as UploadKeyNoActiveTemplateError).organizationId, DENVA_ORG_ID);
        throw err;
      }
    }, UploadKeyNoActiveTemplateError);

    const { data: unchanged } = await supabase.from("organization_upload_keys").select("data_source_type").eq("id", key.id).single();
    assert.equal(unchanged?.data_source_type, "flowmaster");
  } finally {
    await deleteTestUploadKey(key.id);
  }
});

test("updateUploadKeyDataSourceType: csv_template succeeds once the organization has an active template, and records updated_at/updated_by", async () => {
  const key = await createTestUploadKey("flowmaster");
  const { template, cleanup } = await seedActiveTemplate(DENVA_ORG_ID);

  try {
    const before = new Date();
    const result = await updateUploadKeyDataSourceType(key.id, "csv_template", TEST_ADMIN_ID);

    assert.equal(result.dataSourceType, "csv_template");
    assert.equal(result.unchanged, false);
    assert.ok(result.updatedAt);
    assert.ok(new Date(result.updatedAt!).getTime() >= before.getTime() - 1000);
    assert.equal(result.updatedBy, TEST_ADMIN_ID);

    const { data: row } = await supabase
      .from("organization_upload_keys")
      .select("data_source_type, updated_at, updated_by")
      .eq("id", key.id)
      .single();
    assert.equal(row?.data_source_type, "csv_template");
    assert.equal(row?.updated_by, TEST_ADMIN_ID);
  } finally {
    await cleanupAll(() => deleteTestUploadKey(key.id), () => cleanup());
    void template;
  }
});

test("updateUploadKeyDataSourceType: a disabled (inactive) template does not count as active — csv_template is still blocked", async () => {
  const key = await createTestUploadKey("flowmaster");
  const { template, cleanup } = await seedActiveTemplate(DENVA_ORG_ID);

  try {
    await supabase.from("csv_mapping_templates").update({ is_active: false }).eq("id", template.id);

    await assert.rejects(() => updateUploadKeyDataSourceType(key.id, "csv_template", TEST_ADMIN_ID), UploadKeyNoActiveTemplateError);
  } finally {
    await cleanupAll(() => deleteTestUploadKey(key.id), () => cleanup());
  }
});

test("updateUploadKeyDataSourceType: never regenerates or exposes the raw key — key_hash is untouched and the result carries no key material", async () => {
  const key = await createTestUploadKey("flowmaster");
  try {
    const result = await updateUploadKeyDataSourceType(key.id, "generic_csv", TEST_ADMIN_ID);

    assert.equal("key" in result, false);
    assert.equal("rawKey" in result, false);
    assert.equal("keyHash" in result, false);
    assert.equal("key_hash" in result, false);

    const { data: row } = await supabase.from("organization_upload_keys").select("key_hash").eq("id", key.id).single();
    assert.equal(row?.key_hash, key.keyHash);
  } finally {
    await deleteTestUploadKey(key.id);
  }
});
