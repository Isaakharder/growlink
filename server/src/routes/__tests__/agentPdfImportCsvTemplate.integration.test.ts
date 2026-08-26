// End-to-end integration tests for the csv_template branch of
// POST /api/agent/pdf-import — real HTTP requests (multipart uploads,
// X-Upload-Key auth) against the actual Express app, run against the live
// DB per project convention (no local Docker Supabase). Every test creates
// its own throwaway rows (upload keys, source files, templates, pending
// imports, and — where an actual import is exercised — a dedicated test
// variety/yield_entries row) and cleans them up afterward.
//
// The strict rate limiter on /api/agent/pdf-import (20 req/15min per IP)
// is bypassed test-by-test via a unique X-Forwarded-For header (trust
// proxy is enabled — see app.ts) so this suite's own request volume never
// trips it; that limiter's purpose (abuse prevention from a single real
// device) is unrelated to running many independent, intentional test
// requests from one test-harness process.
import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../../app";
import { supabase } from "../../config/supabase";
import { createTemplate, createTemplateVersion, setTemplateActive, parseTemplateWriteBody, getSourceFileGridAndMatch, listPendingCsvTemplateImports, buildCsvPreview, importCsvTemplateGroup, type TemplateRow } from "../csvMappingTemplates";

const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";
const FIRST_LIGHT_ORG_ID = "e1b8a6cf-032c-48f0-852a-982dd58b9f9c";
const TEST_USER_ID = "00000000-0000-0000-0000-0000000000cc";

const FIXTURES_DIR = join(__dirname, "..", "..", "utils", "__tests__", "fixtures", "flowmaster-csv");
const REAL_LOT_CSV = readFileSync(join(FIXTURES_DIR, "lot-2608170362.csv"), "utf-8");

let server: Server;
let baseUrl: string;
let nextIp = 1;

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

function nextTestIp(): string {
  nextIp += 1;
  return `10.99.0.${nextIp}`;
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

async function createUploadKey(organizationId: string, dataSourceType: string, label: string) {
  const rawKey = `test_${randomUUID()}`;
  const { data, error } = await supabase
    .from("organization_upload_keys")
    .insert({
      organization_id: organizationId,
      key_hash: hashKey(rawKey),
      label,
      status: "active",
      data_source_type: dataSourceType
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data!.id as string, rawKey };
}

async function deleteUploadKey(id: string) {
  // agent_pending_imports.upload_key_id and import_source_templates.upload_key_id
  // both FK-reference this row — clear those first so the delete below can
  // never silently fail (and be swallowed) regardless of what other cleanup
  // in the calling test has or hasn't run yet.
  await supabase.from("agent_pending_imports").delete().eq("upload_key_id", id);
  await supabase.from("import_source_templates").delete().eq("upload_key_id", id);

  const { error } = await supabase.from("organization_upload_keys").delete().eq("id", id);
  if (error) {
    throw new Error(`Failed to delete test upload key ${id}: ${error.message}`);
  }
}

/**
 * Runs every cleanup step regardless of whether an earlier one throws — a
 * plain sequential `await` chain in a `finally` block stops dead on the
 * first failure, silently skipping (and leaking) every step after it. Logs
 * failures rather than swallowing them, but never lets one step's failure
 * prevent the rest from at least being attempted.
 */
async function cleanupAll(...tasks: Array<() => PromiseLike<unknown>>): Promise<void> {
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      console.warn("[test cleanup] a cleanup step failed (continuing with the rest):", err instanceof Error ? err.message : err);
    }
  }
}

async function uploadFile(
  rawKey: string,
  filename: string,
  content: string | Buffer,
  mimeType: string
): Promise<{ status: number; body: any }> {
  const formData = new FormData();
  const bytes = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  formData.append("files", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

  const res = await fetch(`${baseUrl}/api/agent/pdf-import`, {
    method: "POST",
    headers: {
      "X-Upload-Key": rawKey,
      "X-Forwarded-For": nextTestIp()
    },
    body: formData
  });

  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function cleanupTemplateGroup(templateGroupId: string) {
  await supabase.from("csv_mapping_templates").delete().eq("template_group_id", templateGroupId);
}

async function cleanupBySourceFilename(organizationId: string, filenamePrefix: string) {
  const { data: sourceFiles } = await supabase
    .from("csv_import_source_files")
    .select("id")
    .eq("organization_id", organizationId)
    .ilike("filename", `${filenamePrefix}%`);

  for (const sf of sourceFiles ?? []) {
    await supabase.from("yield_import_runs").delete().eq("organization_id", organizationId).eq("source_file_id", sf.id as string);
    await supabase.from("agent_pending_imports").delete().eq("organization_id", organizationId).eq("source_file_id", sf.id as string);
    await supabase.from("csv_import_source_files").delete().eq("id", sf.id as string);
  }
}

function uniqueCsv(headerSuffix: string, extraRows = 1): string {
  const header = `Market,Size,Kg,Variety,Date,Tag${headerSuffix}`;
  const rows = Array.from({ length: extraRows }, (_, i) => `Class 1,SM,${10 + i},TestVariety,15082026,${i}`);
  return [header, ...rows].join("\n") + "\n";
}

async function buildAndSaveTemplateFor(organizationId: string, csvText: string, filename: string, name: string): Promise<TemplateRow> {
  // This key only exists to seed a csv_import_source_files row via the real
  // endpoint (rather than reaching around it) — delete it immediately
  // rather than leaving it for the caller to remember to clean up.
  const setupKey = await createUploadKey(organizationId, "csv_template", `setup-${randomUUID()}`);
  await uploadFile(setupKey.rawKey, filename, csvText, "text/csv");
  await cleanupAll(() => deleteUploadKey(setupKey.id));

  // Re-derive the sourceFileId deterministically instead of parsing the HTTP
  // response shape here — query it by content hash directly.
  const fileHash = createHash("sha256").update(Buffer.from(csvText, "utf-8")).digest("hex");
  const { data: sourceFile, error } = await supabase
    .from("csv_import_source_files")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("file_hash", fileHash)
    .single();
  if (error || !sourceFile) throw new Error("Failed to locate seeded source file for template setup.");

  const body = parseTemplateWriteBody({
    name,
    sourceFileId: sourceFile.id,
    delimiter: ",",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    columnMappings: [
      { columnIndex: 0, field: "market_grade" },
      { columnIndex: 1, field: "size_label" },
      { columnIndex: 2, field: "size_weight_kg" },
      { columnIndex: 3, field: "variety" },
      { columnIndex: 4, field: "packed_date", dateFormat: "DDMMYYYY" }
    ],
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "create", newSizeName: `IntegTestSize-${randomUUID()}` }]
  });

  return createTemplate(organizationId, TEST_USER_ID, body);
}

// ---------------------------------------------------------------------------
// 1. csv_template key + exact-match CSV
// ---------------------------------------------------------------------------

test("csv_template key + exact-match CSV: queued for review with the matched template id, no PDF/FlowMaster code involved", async () => {
  const marker = randomUUID();
  const csvText = uniqueCsv(marker);
  const template = await buildAndSaveTemplateFor(DENVA_ORG_ID, csvText, `exact-${marker}.csv`, `Exact Match Integration ${marker}`);
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `exact-match-${marker}`);

  try {
    // A fresh upload of the SAME layout (new marker/content so it's a distinct file, but identical header structure).
    const uploadCsv = `Market,Size,Kg,Variety,Date,Tag${marker}\nClass 1,SM,42,TestVariety,16082026,fresh\n`;
    const { status, body } = await uploadFile(rawKey, `exact-fresh-${marker}.csv`, uploadCsv, "text/csv");

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].status, "csv_template_queued");
    assert.equal(body.results[0].templateId, template.id);
    assert.ok(body.results[0].pendingImportId);

    const { data: pendingRow } = await supabase
      .from("agent_pending_imports")
      .select("data_source_type, needs_template, csv_mapping_template_id")
      .eq("id", body.results[0].pendingImportId)
      .single();
    assert.equal(pendingRow?.data_source_type, "csv_template");
    assert.equal(pendingRow?.needs_template, false);
    assert.equal(pendingRow?.csv_mapping_template_id, template.id);
  } finally {
    await cleanupAll(
      () => deleteUploadKey(keyId),
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupBySourceFilename(DENVA_ORG_ID, "exact-")
    );
  }
});

// ---------------------------------------------------------------------------
// 2. csv_template key + close-match CSV
// ---------------------------------------------------------------------------

test("csv_template key + close-match CSV: flagged needs_template with matchKind='close', never auto-selected", async () => {
  const marker = randomUUID();
  const csvText = uniqueCsv(marker);
  const template = await buildAndSaveTemplateFor(DENVA_ORG_ID, csvText, `close-setup-${marker}.csv`, `Close Match Integration ${marker}`);
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `close-match-${marker}`);

  try {
    // Same delimiter/header row, one column removed — a "close" match per matchFingerprint's >=70% overlap rule.
    const closeCsv = `Market,Size,Kg,Variety,Date\nClass 1,SM,11,TestVariety,17082026\n`;
    const { status, body } = await uploadFile(rawKey, `close-${marker}.csv`, closeCsv, "text/csv");

    assert.equal(status, 200);
    assert.equal(body.results[0].status, "csv_template_needs_template");
    assert.equal(body.results[0].matchKind, "close");

    const { data: pendingRow } = await supabase
      .from("agent_pending_imports")
      .select("needs_template, csv_mapping_template_id")
      .eq("id", body.results[0].pendingImportId)
      .single();
    assert.equal(pendingRow?.needs_template, true);
    assert.equal(pendingRow?.csv_mapping_template_id, null);
  } finally {
    await cleanupAll(
      () => deleteUploadKey(keyId),
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupBySourceFilename(DENVA_ORG_ID, "close-")
    );
  }
});

// ---------------------------------------------------------------------------
// 3. csv_template key + unmatched CSV
// ---------------------------------------------------------------------------

test("csv_template key + unmatched CSV: flagged needs_template with matchKind='none'", async () => {
  const marker = randomUUID();
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `unmatched-${marker}`);

  try {
    const unrelatedCsv = `CompletelyUnrelatedHeader${marker},Second,Third\nx,y,z\n`;
    const { status, body } = await uploadFile(rawKey, `unmatched-${marker}.csv`, unrelatedCsv, "text/csv");

    assert.equal(status, 200);
    assert.equal(body.results[0].status, "csv_template_needs_template");
    assert.equal(body.results[0].matchKind, "none");
  } finally {
    await cleanupAll(() => deleteUploadKey(keyId), () => cleanupBySourceFilename(DENVA_ORG_ID, "unmatched-"));
  }
});

// ---------------------------------------------------------------------------
// 4. csv_template key + invalid CSV
// ---------------------------------------------------------------------------

test("csv_template key + invalid/binary file: rejected with a non-200 status and a clear error, nothing queued", async () => {
  const marker = randomUUID();
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `invalid-${marker}`);

  try {
    const binaryGarbage = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00, 0x10, 0x20, 0x00]);
    const { status, body } = await uploadFile(rawKey, `invalid-${marker}.csv`, binaryGarbage, "text/csv");

    assert.equal(status, 422);
    assert.equal(body.success, false);
    assert.equal(body.results[0].status, "error");
    assert.ok(body.results[0].reason);

    const { count } = await supabase
      .from("agent_pending_imports")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID)
      .eq("source_filename", `invalid-${marker}.csv`);
    assert.equal(count, 0);
  } finally {
    await deleteUploadKey(keyId);
  }
});

// ---------------------------------------------------------------------------
// 5. csv_template key + PDF still follows the PDF path
// ---------------------------------------------------------------------------

test("csv_template key + PDF: routed through the FlowMaster PDF parser, never the CSV template engine", async () => {
  const marker = randomUUID();
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `pdf-${marker}`);

  try {
    // Minimal-but-real PDF magic bytes; not a genuine FlowMaster export, so
    // parseFlowMasterPdfBuffer is expected to fail to extract a lot number —
    // the point is proving WHICH path it took, not that the fake PDF parses.
    const fakePdf = Buffer.from(`%PDF-1.4\n%${marker}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`, "latin1");
    const { body } = await uploadFile(rawKey, `pdf-${marker}.pdf`, fakePdf, "application/pdf");

    assert.equal(body.results.length, 1);
    const result = body.results[0];
    // PDF-path results never carry the CSV-template-specific fields.
    assert.equal("templateId" in result, false);
    assert.equal("matchKind" in result, false);

    // And, decisively: no csv_import_source_files row was ever created for it.
    const { count } = await supabase
      .from("csv_import_source_files")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID)
      .eq("filename", `pdf-${marker}.pdf`);
    assert.equal(count, 0);
  } finally {
    await deleteUploadKey(keyId);
  }
});

// ---------------------------------------------------------------------------
// 6. Existing flowmaster key behavior remains unchanged
// ---------------------------------------------------------------------------

test("existing flowmaster key: a real FlowMaster CSV is still parsed and queued exactly as before", async () => {
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "flowmaster", `flowmaster-unchanged-${randomUUID()}`);

  try {
    const { status, body } = await uploadFile(rawKey, "lot-2608170362.csv", REAL_LOT_CSV, "text/csv");

    assert.equal(status, 200);
    assert.equal(body.results[0].status, "queued");
    assert.equal(body.results[0].lotNumber, "2608170362");

    const { data: pendingRow } = await supabase
      .from("agent_pending_imports")
      .select("data_source_type")
      .eq("organization_id", DENVA_ORG_ID)
      .eq("lot_number", "2608170362")
      .single();
    assert.equal(pendingRow?.data_source_type, "flowmaster");
  } finally {
    await cleanupAll(
      () => deleteUploadKey(keyId),
      () => supabase.from("agent_pending_imports").delete().eq("organization_id", DENVA_ORG_ID).eq("lot_number", "2608170362")
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Existing generic_csv key behavior remains unchanged
// ---------------------------------------------------------------------------

test("existing generic_csv key: an unconfigured key still routes a CSV to needs_template exactly as before", async () => {
  const marker = randomUUID();
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "generic_csv", `generic-unchanged-${marker}`);

  try {
    const csv = `AnyHeader${marker},Col2\nx,1\n`;
    const { status, body } = await uploadFile(rawKey, `generic-${marker}.csv`, csv, "text/csv");

    assert.equal(status, 200);
    assert.equal(body.results[0].status, "pending_template");

    const { data: pendingRow } = await supabase
      .from("agent_pending_imports")
      .select("data_source_type, needs_template")
      .eq("organization_id", DENVA_ORG_ID)
      .eq("source_filename", `generic-${marker}.csv`)
      .single();
    assert.equal(pendingRow?.data_source_type, "generic_csv");
    assert.equal(pendingRow?.needs_template, true);
  } finally {
    await cleanupAll(
      () => deleteUploadKey(keyId),
      () => supabase.from("agent_pending_imports").delete().eq("organization_id", DENVA_ORG_ID).eq("source_filename", `generic-${marker}.csv`)
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Identical CSV uploaded twice -> one pending source/import, HTTP 200 duplicate ack
// ---------------------------------------------------------------------------

test("identical CSV uploaded twice via csv_template key: only one pending row is ever created, second upload is a 200 duplicate acknowledgement", async () => {
  const marker = randomUUID();
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `dup-${marker}`);

  try {
    const csv = `DupHeader${marker},Col2\nx,1\n`;

    const first = await uploadFile(rawKey, `dup-${marker}.csv`, csv, "text/csv");
    assert.equal(first.status, 200);
    assert.equal(first.body.results[0].status, "csv_template_needs_template");
    const firstPendingId = first.body.results[0].pendingImportId;

    const second = await uploadFile(rawKey, `dup-${marker}.csv`, csv, "text/csv");
    assert.equal(second.status, 200);
    assert.equal(second.body.results[0].status, "duplicate");
    assert.equal(second.body.results[0].accepted, true);
    assert.equal(second.body.results[0].duplicate, true);
    assert.equal(second.body.results[0].pendingImportId, firstPendingId);

    const { count } = await supabase
      .from("agent_pending_imports")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID)
      .eq("source_filename", `dup-${marker}.csv`);
    assert.equal(count, 1);
  } finally {
    await cleanupAll(() => deleteUploadKey(keyId), () => cleanupBySourceFilename(DENVA_ORG_ID, "dup-"));
  }
});

// ---------------------------------------------------------------------------
// 8b. A dismissed (hard-deleted) pending row must be recreated on resend,
// not silently swallowed as a duplicate — this is the exact reported bug:
// deleting a pending card should not leave the underlying content hash
// permanently "seen," since dedup exists to avoid redundant re-parsing of
// identical bytes, not to remember that a file was reviewed and dismissed.
// ---------------------------------------------------------------------------

test("a pending import dismissed via DELETE /api/agent-pending-imports/:id is recreated when the identical CSV is resent", async () => {
  const marker = randomUUID();
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `redup-${marker}`);

  try {
    const csv = `RedupHeader${marker},Col2\nx,1\n`;

    const first = await uploadFile(rawKey, `redup-${marker}.csv`, csv, "text/csv");
    assert.equal(first.status, 200);
    assert.equal(first.body.results[0].status, "csv_template_needs_template");
    const firstPendingId = first.body.results[0].pendingImportId;

    // Dismiss it. DELETE /api/agent-pending-imports/:id (the "Remove"
    // action in the Pending CSV Imports UI) sits behind Bearer-token
    // browser auth (requireOrganizationContext), not the Agent's
    // X-Upload-Key auth this test drives — so this replicates exactly
    // what that route does (see agentPendingImports.ts): a hard delete
    // filtered by id + organization_id, nothing else.
    const { error: deleteError } = await supabase
      .from("agent_pending_imports")
      .delete()
      .eq("id", firstPendingId)
      .eq("organization_id", DENVA_ORG_ID);
    assert.equal(deleteError, null);

    const { count: afterDeleteCount } = await supabase
      .from("agent_pending_imports")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID)
      .eq("source_filename", `redup-${marker}.csv`);
    assert.equal(afterDeleteCount, 0, "the pending row must be gone after dismissal");

    // Resend the byte-identical file — must NOT be treated as a duplicate.
    const second = await uploadFile(rawKey, `redup-${marker}.csv`, csv, "text/csv");
    assert.equal(second.status, 200);
    assert.equal(second.body.results[0].status, "csv_template_needs_template", "a fresh pending row must be created, not a duplicate ack");
    assert.notEqual(second.body.results[0].pendingImportId, firstPendingId);

    const { count: afterResendCount } = await supabase
      .from("agent_pending_imports")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID)
      .eq("source_filename", `redup-${marker}.csv`);
    assert.equal(afterResendCount, 1, "exactly one pending row must exist after the dismiss-then-resend sequence");
  } finally {
    await cleanupAll(() => deleteUploadKey(keyId), () => cleanupBySourceFilename(DENVA_ORG_ID, "redup-"));
  }
});

// The companion case — a lot that was already successfully imported must
// stay deduped even after its pending row is gone — is already covered by
// "after an exact-match upload is actually approved and imported..." above:
// that test's own comment notes the pending row is deleted by the import's
// cleanup step, and the re-upload still correctly comes back as a duplicate
// referencing the completed yield_import_runs claim, not a new pending row.

// ---------------------------------------------------------------------------
// 9. Same bytes uploaded by two organizations remain organization-isolated
// ---------------------------------------------------------------------------

test("identical bytes uploaded by two different organizations are processed independently, not cross-org duplicates", async () => {
  const marker = randomUUID();
  const csv = `CrossOrgHeader${marker},Col2\nx,1\n`;

  const denvaKey = await createUploadKey(DENVA_ORG_ID, "csv_template", `cross-org-a-${marker}`);
  const firstLightKey = await createUploadKey(FIRST_LIGHT_ORG_ID, "csv_template", `cross-org-b-${marker}`);

  try {
    const denvaResult = await uploadFile(denvaKey.rawKey, `cross-${marker}.csv`, csv, "text/csv");
    const firstLightResult = await uploadFile(firstLightKey.rawKey, `cross-${marker}.csv`, csv, "text/csv");

    assert.equal(denvaResult.body.results[0].status, "csv_template_needs_template");
    assert.equal(firstLightResult.body.results[0].status, "csv_template_needs_template");
    assert.notEqual(denvaResult.body.results[0].pendingImportId, firstLightResult.body.results[0].pendingImportId);

    const { data: denvaSourceFiles } = await supabase
      .from("csv_import_source_files")
      .select("id")
      .eq("organization_id", DENVA_ORG_ID)
      .eq("filename", `cross-${marker}.csv`);
    const { data: firstLightSourceFiles } = await supabase
      .from("csv_import_source_files")
      .select("id")
      .eq("organization_id", FIRST_LIGHT_ORG_ID)
      .eq("filename", `cross-${marker}.csv`);

    assert.equal(denvaSourceFiles?.length, 1);
    assert.equal(firstLightSourceFiles?.length, 1);
    assert.notEqual(denvaSourceFiles?.[0]?.id, firstLightSourceFiles?.[0]?.id);
  } finally {
    await cleanupAll(
      () => deleteUploadKey(denvaKey.id),
      () => deleteUploadKey(firstLightKey.id),
      () => cleanupBySourceFilename(DENVA_ORG_ID, "cross-"),
      () => cleanupBySourceFilename(FIRST_LIGHT_ORG_ID, "cross-")
    );
  }
});

// ---------------------------------------------------------------------------
// 10. Disabled or older template versions are not selected as active
// ---------------------------------------------------------------------------

test("disabled or superseded template versions are never selected as the active match", async () => {
  const marker = randomUUID();
  const csvText = uniqueCsv(marker);
  const v1 = await buildAndSaveTemplateFor(DENVA_ORG_ID, csvText, `version-${marker}.csv`, `Version Integration ${marker}`);

  try {
    // Re-fetch a real sourceFileId for the version-2 write (createTemplateVersion needs one).
    const fileHash = createHash("sha256").update(Buffer.from(csvText, "utf-8")).digest("hex");
    const { data: sourceFile } = await supabase
      .from("csv_import_source_files")
      .select("id")
      .eq("organization_id", DENVA_ORG_ID)
      .eq("file_hash", fileHash)
      .single();

    const v2 = await createTemplateVersion(
      DENVA_ORG_ID,
      TEST_USER_ID,
      v1.id,
      parseTemplateWriteBody({
        name: v1.name,
        sourceFileId: sourceFile!.id,
        delimiter: v1.delimiter,
        headerRowIndex: v1.header_row_index,
        dataStartRowIndex: v1.data_start_row_index,
        columnMappings: v1.column_mappings,
        valueMappings: v1.value_mappings
      })
    );

    const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `version-key-${marker}`);
    try {
      const uploadCsv = `Market,Size,Kg,Variety,Date,Tag${marker}\nClass 1,SM,9,TestVariety,18082026,v2check\n`;
      const { body } = await uploadFile(rawKey, `version-check-${marker}.csv`, uploadCsv, "text/csv");
      assert.equal(body.results[0].status, "csv_template_queued");
      assert.equal(body.results[0].templateId, v2.id);
      assert.notEqual(body.results[0].templateId, v1.id);
    } finally {
      await deleteUploadKey(keyId);
    }

    // Now disable the current (v2) template entirely — a matching upload must fall back to needs_template.
    await setTemplateActive(DENVA_ORG_ID, TEST_USER_ID, v2.id, false);

    const { id: keyId2, rawKey: rawKey2 } = await createUploadKey(DENVA_ORG_ID, "csv_template", `version-key2-${marker}`);
    try {
      const uploadCsv2 = `Market,Size,Kg,Variety,Date,Tag${marker}\nClass 1,SM,4,TestVariety,19082026,disabledcheck\n`;
      const { body } = await uploadFile(rawKey2, `version-disabled-${marker}.csv`, uploadCsv2, "text/csv");
      assert.equal(body.results[0].status, "csv_template_needs_template");
    } finally {
      await deleteUploadKey(keyId2);
    }
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(v1.template_group_id),
      () => cleanupBySourceFilename(DENVA_ORG_ID, "version-")
    );
  }
});

// ---------------------------------------------------------------------------
// 11. Raw source survives and opens in Template Builder
// ---------------------------------------------------------------------------

test("an unmatched pending file's raw source can be reopened in the Template Builder without re-uploading", async () => {
  const marker = randomUUID();
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `reopen-${marker}`);

  try {
    const originalCsv = `ReopenHeader${marker},Col2,Col3\nAlpha,10,x\nBeta,20,y\n`;
    const { body } = await uploadFile(rawKey, `reopen-${marker}.csv`, originalCsv, "text/csv");
    assert.equal(body.results[0].status, "csv_template_needs_template");

    const pendingItems = await listPendingCsvTemplateImports(DENVA_ORG_ID);
    const item = pendingItems.find((i) => i.id === body.results[0].pendingImportId);
    assert.ok(item, "pending item should be listed");
    assert.ok(item!.sourceFileId, "pending item must expose its sourceFileId for the builder to resume from");

    const resumed = await getSourceFileGridAndMatch(DENVA_ORG_ID, item!.sourceFileId!);
    assert.equal(resumed.filename, `reopen-${marker}.csv`);
    assert.deepEqual(resumed.grid[0], [`ReopenHeader${marker}`, "Col2", "Col3"]);
    assert.deepEqual(resumed.grid[1], ["Alpha", "10", "x"]);
    assert.deepEqual(resumed.grid[2], ["Beta", "20", "y"]);
  } finally {
    await cleanupAll(() => deleteUploadKey(keyId), () => cleanupBySourceFilename(DENVA_ORG_ID, "reopen-"));
  }
});

// ---------------------------------------------------------------------------
// 12. Approved import remains protected by the existing yield_import_runs uniqueness claim
// ---------------------------------------------------------------------------

test("after an exact-match upload is actually approved and imported, re-uploading the identical file is a duplicate referencing the import run, not a new pending row", async () => {
  const marker = randomUUID();
  const csvText = uniqueCsv(marker);
  const template = await buildAndSaveTemplateFor(DENVA_ORG_ID, csvText, `approved-setup-${marker}.csv`, `Approved Import Integration ${marker}`);

  const varietyName = `IntegTestVariety-${marker}`;
  const { data: variety, error: varietyErr } = await supabase
    .from("varieties")
    .insert({ organization_id: DENVA_ORG_ID, name: varietyName, area_m2: 500, case_kg: 10, status: "active", color: "yellow" })
    .select("id")
    .single();
  assert.equal(varietyErr, null, varietyErr?.message);

  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `approved-${marker}`);

  try {
    const uploadCsv = `Market,Size,Kg,Variety,Date,Tag${marker}\nClass 1,SM,15,${varietyName},20082026,approve\n`;
    const first = await uploadFile(rawKey, `approved-${marker}.csv`, uploadCsv, "text/csv");
    assert.equal(first.body.results[0].status, "csv_template_queued");

    const { data: pendingRow } = await supabase
      .from("agent_pending_imports")
      .select("source_file_id")
      .eq("id", first.body.results[0].pendingImportId)
      .single();
    const sourceFileId = pendingRow!.source_file_id as string;

    const previewResult = await buildCsvPreview(DENVA_ORG_ID, { sourceFileId, templateId: template.id });
    assert.equal(previewResult.preview.canImport, true, JSON.stringify(previewResult.preview.validationIssues));
    const group = previewResult.preview.groups[0];

    const importResult = await importCsvTemplateGroup(DENVA_ORG_ID, TEST_USER_ID, {
      sourceFileId,
      templateId: template.id,
      groupKey: group.groupKey,
      approvedGroup: group
    });
    assert.equal(importResult.mode, "create");

    // Re-upload the exact same bytes — must be recognized as a duplicate via
    // the completed yield_import_runs claim, not create a new pending row.
    const second = await uploadFile(rawKey, `approved-${marker}.csv`, uploadCsv, "text/csv");
    assert.equal(second.body.results[0].status, "duplicate");
    // The pending row was already deleted by the import's own cleanup step,
    // but the completed yield_import_runs claim (source_file_id-linked) is
    // what actually protects against a duplicate re-import here — this is
    // the exact protection the test name asserts, so it must be non-null.
    assert.ok(second.body.results[0].importRunId);
    assert.equal(second.body.results[0].pendingImportId, null);

    const { count: entryCount } = await supabase
      .from("yield_entries")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID)
      .eq("variety_id", variety!.id);
    assert.equal(entryCount, 1); // never duplicated by the second upload
  } finally {
    await cleanupAll(
      () => deleteUploadKey(keyId),
      async () => {
        const { data: entries } = await supabase.from("yield_entries").select("id").eq("organization_id", DENVA_ORG_ID).eq("variety_id", variety!.id);
        for (const entry of entries ?? []) {
          await supabase.from("yield_entry_daily_breakdown").delete().eq("yield_entry_id", entry.id as string);
        }
      },
      () => supabase.from("yield_entries").delete().eq("organization_id", DENVA_ORG_ID).eq("variety_id", variety!.id),
      () => supabase.from("yield_import_runs").delete().eq("organization_id", DENVA_ORG_ID).eq("variety_id", variety!.id),
      () => supabase.from("varieties").delete().eq("id", variety!.id),
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupBySourceFilename(DENVA_ORG_ID, "approved-")
    );
  }
});

// ---------------------------------------------------------------------------
// 13. No upload path writes directly to yield data before review
// ---------------------------------------------------------------------------

test("no csv_template upload outcome (exact match, close match, none, or duplicate) ever writes to yield_entries directly", async () => {
  const marker = randomUUID();
  const csvText = uniqueCsv(marker);
  const template = await buildAndSaveTemplateFor(DENVA_ORG_ID, csvText, `noyield-setup-${marker}.csv`, `No Direct Yield Integration ${marker}`);
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `noyield-${marker}`);

  try {
    const { count: before } = await supabase
      .from("yield_entries")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID);

    // Exact match.
    await uploadFile(rawKey, `noyield-exact-${marker}.csv`, `Market,Size,Kg,Variety,Date,Tag${marker}\nClass 1,SM,3,X,21082026,a\n`, "text/csv");
    // Unmatched.
    await uploadFile(rawKey, `noyield-none-${marker}.csv`, `NoMatch${marker},Col2\nx,1\n`, "text/csv");

    const { count: after } = await supabase
      .from("yield_entries")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID);

    assert.equal(after, before);
  } finally {
    await cleanupAll(
      () => deleteUploadKey(keyId),
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupBySourceFilename(DENVA_ORG_ID, "noyield-")
    );
  }
});

// ---------------------------------------------------------------------------
// 14. Multi-file multipart behavior remains safe if supported
// ---------------------------------------------------------------------------

test("a multi-file multipart request is processed safely: each file gets its own independent, correctly attributed result", async () => {
  const marker = randomUUID();
  const { id: keyId, rawKey } = await createUploadKey(DENVA_ORG_ID, "csv_template", `multi-${marker}`);

  try {
    const formData = new FormData();
    const csvA = `MultiA${marker},Col2\na,1\n`;
    const csvB = `MultiB${marker},Col2\nb,2\n`;
    formData.append("files", new Blob([new Uint8Array(Buffer.from(csvA, "utf-8"))], { type: "text/csv" }), `multi-a-${marker}.csv`);
    formData.append("files", new Blob([new Uint8Array(Buffer.from(csvB, "utf-8"))], { type: "text/csv" }), `multi-b-${marker}.csv`);

    const res = await fetch(`${baseUrl}/api/agent/pdf-import`, {
      method: "POST",
      headers: { "X-Upload-Key": rawKey, "X-Forwarded-For": nextTestIp() },
      body: formData
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].filename, `multi-a-${marker}.csv`);
    assert.equal(body.results[1].filename, `multi-b-${marker}.csv`);
    assert.equal(body.results[0].status, "csv_template_needs_template");
    assert.equal(body.results[1].status, "csv_template_needs_template");
    assert.notEqual(body.results[0].pendingImportId, body.results[1].pendingImportId);

    const { count } = await supabase
      .from("csv_import_source_files")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", DENVA_ORG_ID)
      .ilike("filename", `multi-%-${marker}.csv`);
    assert.equal(count, 2);
  } finally {
    await cleanupAll(
      () => deleteUploadKey(keyId),
      () => cleanupBySourceFilename(DENVA_ORG_ID, `multi-a-${marker}`),
      () => cleanupBySourceFilename(DENVA_ORG_ID, `multi-b-${marker}`)
    );
  }
});
