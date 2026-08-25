// Tests for the Saved CSV Templates list: the enriched summary shape
// (layout summary, mapped-field/rule counts, resolved created/updated-by
// names), that the list reflects the CURRENT version only after an edit,
// that enable/disable is correctly recognized by the upload-key gate
// (including the case where an OLDER, non-current version is still
// active — that must NOT count), and that a rapid double "Save as
// template" can't create two templates for the same layout.
import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { supabase } from "../../config/supabase";
import { csvMappingTemplatesRouter } from "../csvMappingTemplates";
import {
  parseAndMatchCsvFile,
  listTemplatesForOrg,
  createTemplate,
  createTemplateVersion,
  setTemplateActive,
  parseTemplateWriteBody,
  TemplateConflictError,
  type TemplateWriteInput
} from "../csvMappingTemplates";
import { updateUploadKeyDataSourceType, UploadKeyNoActiveTemplateError } from "../adminUploadKeys";

const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";
const TEST_USER_ID = "00000000-0000-0000-0000-0000000000cc";
const TEST_ADMIN_ID = "00000000-0000-0000-0000-0000000000dd";

let server: Server;
let baseUrl: string;
let realOwnerUserId: string;

before(async () => {
  // requireAnyPermission/requirePermission check a REAL memberships row —
  // a fabricated user id like TEST_USER_ID gets a genuine 403, not just a
  // stand-in. Use a real member of Denva for the HTTP-level requests.
  const { data } = await supabase.from("memberships").select("user_id").eq("organization_id", DENVA_ORG_ID).limit(1).maybeSingle();
  if (!data?.user_id) throw new Error("No real Denva membership found to run these tests as.");
  realOwnerUserId = data.user_id as string;

  await new Promise<void>((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = realOwnerUserId;
      req.organizationId = DENVA_ORG_ID;
      next();
    });
    app.use("/api", csvMappingTemplatesRouter);
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

async function uploadTestFile(csvText: string, filename = `saved-list-test-${randomUUID()}.csv`) {
  const buffer = Buffer.from(csvText, "utf-8");
  return parseAndMatchCsvFile(DENVA_ORG_ID, TEST_USER_ID, { buffer, originalname: filename });
}

async function cleanupSourceFile(sourceFileId: string) {
  await supabase.from("csv_import_source_files").delete().eq("id", sourceFileId);
}

async function cleanupTemplateGroup(templateGroupId: string) {
  await supabase.from("csv_mapping_templates").delete().eq("template_group_id", templateGroupId);
}

async function cleanupAll(...tasks: Array<() => PromiseLike<unknown>>): Promise<void> {
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      console.warn("[test cleanup] a cleanup step failed (continuing with the rest):", err instanceof Error ? err.message : err);
    }
  }
}

function simpleWriteBody(sourceFileId: string, name: string, userId?: string): TemplateWriteInput {
  void userId;
  return parseTemplateWriteBody({
    name,
    sourceFileId,
    delimiter: ",",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    dataEndRowIndex: null,
    skipRowIndexes: [],
    blankRowBehavior: "skip",
    columnMappings: [
      { columnIndex: 0, field: "market_grade" },
      { columnIndex: 1, field: "size_label" },
      { columnIndex: 2, field: "size_weight_kg" }
    ],
    fixedCellMappings: [],
    valueMappings: [
      { sourceField: "size_label", rawValue: "SM", action: "create", newSizeName: "Small" },
      { sourceField: "size_label", rawValue: "MD", action: "create", newSizeName: "Medium" }
    ],
    rules: [{ id: "r1", priority: 1, conditionLogic: "AND", conditions: [{ field: "market_grade", operator: "equals", value: "waste" }], action: "ignore" }]
  });
}

test("saving + list refresh: GET /csv-templates returns the enriched summary (layout, counts, resolved names)", async () => {
  const csv = `Market,Size,Kg\nClass 1,SM,10\n`;
  const uploaded = await uploadTestFile(csv);
  const templateName = `Saved List Test ${randomUUID()}`;

  const created = await createTemplate(DENVA_ORG_ID, realOwnerUserId, simpleWriteBody(uploaded.sourceFileId, templateName));

  try {
    const res = await fetch(`${baseUrl}/api/csv-templates`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const row = body.find((t) => t.id === created.id);
    assert.ok(row, "newly saved template should appear in the list immediately");

    assert.equal(row!.name, templateName);
    assert.equal(row!.version, 1);
    assert.equal(row!.isActive, true);
    assert.equal(row!.isCurrent, true);
    assert.equal(row!.columnCount, 3);
    assert.equal(row!.mappedFieldsCount, 3);
    assert.equal(row!.rulesCount, 1);
    assert.equal(row!.valueMappingsCount, 2);
    assert.equal(typeof row!.layoutSummary, "string");
    assert.ok((row!.layoutSummary as string).includes("3 column"));
    assert.equal(typeof row!.createdByName, "string");
    assert.notEqual(row!.createdByName, "", "createdByName should never be blank");
  } finally {
    await cleanupAll(() => cleanupTemplateGroup(created.template_group_id), () => cleanupSourceFile(uploaded.sourceFileId));
  }
});

test("version display: after editing, the list shows only the new current version, not the superseded one", async () => {
  const csv = `Market,Size,Kg\nClass 1,SM,10\n`;
  const uploaded = await uploadTestFile(csv);
  const templateName = `Version Display Test ${randomUUID()}`;

  const v1 = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(uploaded.sourceFileId, templateName));
  const v2 = await createTemplateVersion(DENVA_ORG_ID, TEST_USER_ID, v1.id, simpleWriteBody(uploaded.sourceFileId, templateName));

  try {
    assert.equal(v2.version, 2);
    assert.equal(v2.template_group_id, v1.template_group_id);

    const rows = await listTemplatesForOrg(DENVA_ORG_ID);
    const groupRows = rows.filter((r) => r.template_group_id === v1.template_group_id);
    assert.equal(groupRows.length, 1, "only the current version should appear in the list");
    assert.equal(groupRows[0].id, v2.id);
    assert.equal(groupRows[0].version, 2);

    const res = await fetch(`${baseUrl}/api/csv-templates`);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const listedIds = body.filter((t) => t.templateGroupId === v1.template_group_id).map((t) => t.id);
    assert.deepEqual(listedIds, [v2.id]);
  } finally {
    await cleanupAll(() => cleanupTemplateGroup(v1.template_group_id), () => cleanupSourceFile(uploaded.sourceFileId));
  }
});

test("enable/disable: the upload-key gate rejects an older, still-active-but-non-current version — only active AND current counts", async () => {
  const csv = `Market,Size,Kg\nClass 1,SM,10\n`;
  const uploaded = await uploadTestFile(csv);
  const templateName = `Gate Version Test ${randomUUID()}`;

  const v1 = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(uploaded.sourceFileId, templateName));
  // v1 is now is_current=false (but still is_active=true) once v2 exists.
  const v2 = await createTemplateVersion(DENVA_ORG_ID, TEST_USER_ID, v1.id, simpleWriteBody(uploaded.sourceFileId, templateName));

  const rawKey = `test_${randomUUID()}`;
  const { createHash } = await import("node:crypto");
  const { data: keyRow, error: keyErr } = await supabase
    .from("organization_upload_keys")
    .insert({
      organization_id: DENVA_ORG_ID,
      key_hash: createHash("sha256").update(rawKey).digest("hex"),
      label: `saved-list-gate-test-${randomUUID()}`,
      status: "active",
      data_source_type: "flowmaster"
    })
    .select("id")
    .single();
  assert.equal(keyErr, null, keyErr?.message);

  try {
    // With v2 current+active, the gate should succeed.
    const result = await updateUploadKeyDataSourceType(keyRow!.id as string, "csv_template", TEST_ADMIN_ID);
    assert.equal(result.dataSourceType, "csv_template");

    // Disable v2 (the only current version) — now nothing current+active exists,
    // even though v1 (non-current) is still is_active=true.
    await setTemplateActive(DENVA_ORG_ID, TEST_USER_ID, v2.id, false);

    // Switching a DIFFERENT key (or re-switching this one away and back) must
    // now be rejected, since only a non-current version is active.
    await supabase.from("organization_upload_keys").update({ data_source_type: "flowmaster" }).eq("id", keyRow!.id);
    await assert.rejects(
      () => updateUploadKeyDataSourceType(keyRow!.id as string, "csv_template", TEST_ADMIN_ID),
      UploadKeyNoActiveTemplateError
    );
  } finally {
    await cleanupAll(
      () => supabase.from("organization_upload_keys").delete().eq("id", keyRow!.id as string),
      () => cleanupTemplateGroup(v1.template_group_id),
      () => cleanupSourceFile(uploaded.sourceFileId)
    );
  }
});

test("duplicate prevention: two near-simultaneous Save attempts for the identical layout only ever create one template", async () => {
  const csv = `Market,Size,Kg\nClass 1,SM,${randomUUID().slice(0, 4)}\n`; // unique-ish content, unique fingerprint per test run
  const uploaded = await uploadTestFile(csv);
  const templateName = `Duplicate Prevention Test ${randomUUID()}`;
  const body = simpleWriteBody(uploaded.sourceFileId, templateName);

  const results = await Promise.allSettled([
    createTemplate(DENVA_ORG_ID, TEST_USER_ID, body),
    createTemplate(DENVA_ORG_ID, TEST_USER_ID, body)
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  try {
    assert.equal(fulfilled.length, 1, "exactly one of the two simultaneous saves should succeed");
    assert.equal(rejected.length, 1, "the other should be rejected, not silently create a second template");
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof TemplateConflictError);

    const created = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof createTemplate>>>).value;
    const { count } = await supabase
      .from("csv_mapping_templates")
      .select("*", { count: "exact", head: true })
      .eq("template_group_id", created.template_group_id);
    assert.equal(count, 1, "only one row should exist for this layout, not two");
  } finally {
    const created = fulfilled[0]?.status === "fulfilled" ? (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof createTemplate>>>).value : null;
    await cleanupAll(
      () => (created ? cleanupTemplateGroup(created.template_group_id) : Promise.resolve()),
      () => cleanupSourceFile(uploaded.sourceFileId)
    );
  }
});
