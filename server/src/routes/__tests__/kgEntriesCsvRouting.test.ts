// Proves the Kg Entries "PDF / CSV Upload" button's manual-upload route
// (POST /api/pdf-import/preview) routes CSV files through the SAME
// matching/normalization service as the CSV Templates tab and the Agent's
// automated uploads (previewManualCsvUpload -> parseAndMatchCsvFile /
// buildCsvPreview), never the legacy FlowMaster CSV parser — and that PDF
// uploads through the exact same endpoint are completely unaffected.
import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { supabase } from "../../config/supabase";
import { pdfImportRouter } from "../pdfImport";
import {
  createTemplate,
  parseTemplateWriteBody,
  previewManualCsvUpload,
  buildCsvPreview,
  classifyExactMatches,
  type TemplateWriteInput
} from "../csvMappingTemplates";

const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";
const FIRST_LIGHT_ORG_ID = "e1b8a6cf-032c-48f0-852a-982dd58b9f9c";

let server: Server;
let baseUrl: string;
let realOwnerUserId: string;

before(async () => {
  const { data } = await supabase.from("memberships").select("user_id").eq("organization_id", DENVA_ORG_ID).limit(1).maybeSingle();
  if (!data?.user_id) throw new Error("No real Denva membership found to run these tests as.");
  realOwnerUserId = data.user_id as string;

  await new Promise<void>((resolve) => {
    const app = express();
    app.use((req, _res, next) => {
      req.userId = realOwnerUserId;
      req.organizationId = DENVA_ORG_ID;
      next();
    });
    app.use("/api", pdfImportRouter);
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function cleanupAll(...tasks: Array<() => PromiseLike<unknown>>): Promise<void> {
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      console.warn("[test cleanup] a cleanup step failed (continuing with the rest):", err instanceof Error ? err.message : err);
    }
  }
}

async function cleanupTemplateGroup(templateGroupId: string) {
  await supabase.from("csv_mapping_templates").delete().eq("template_group_id", templateGroupId);
}

async function cleanupSourceFilesByOrgFilenamePrefix(organizationId: string, prefix: string) {
  await supabase.from("csv_import_source_files").delete().eq("organization_id", organizationId).ilike("filename", `${prefix}%`);
}

async function cleanupPendingByOrgFilenamePrefix(organizationId: string, prefix: string) {
  await supabase.from("agent_pending_imports").delete().eq("organization_id", organizationId).ilike("source_filename", `${prefix}%`);
}

function simpleWriteBody(sourceFileId: string, name: string): TemplateWriteInput {
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
      { columnIndex: 2, field: "size_weight_kg" },
      { columnIndex: 3, field: "variety" },
      { columnIndex: 4, field: "packed_date", dateFormat: "DDMMYYYY" }
    ],
    fixedCellMappings: [],
    valueMappings: [{ sourceField: "size_label", rawValue: "SM", action: "create", newSizeName: `KgEntriesRoutingSmall-${randomUUID()}` }],
    rules: []
  });
}

async function uploadCsvViaKgEntries(csvText: string, filename: string) {
  const form = new FormData();
  form.append("files", new Blob([csvText], { type: "text/csv" }), filename);
  const res = await fetch(`${baseUrl}/api/pdf-import/preview`, { method: "POST", body: form });
  return { status: res.status, body: (await res.json()) as { success: boolean; files: Array<Record<string, unknown>> } };
}

test("exact match: a manual CSV upload from Kg Entries is routed to the saved template, not the legacy parser", async () => {
  const prefix = `kg-routing-exact-${randomUUID()}`;
  const csv = `Market,Size,Kg,Variety,Date\nClass 1,SM,12.5,Cadalora,15082026\n`;
  const uploaded = await previewManualCsvUpload(DENVA_ORG_ID, realOwnerUserId, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  assert.equal(uploaded.kind, "none"); // no template saved yet
  const sourceFileId = uploaded.sourceFileId;

  const template = await createTemplate(DENVA_ORG_ID, realOwnerUserId, simpleWriteBody(sourceFileId, `${prefix}-template`));

  try {
    const { status, body } = await uploadCsvViaKgEntries(csv, `${prefix}.csv`);
    assert.equal(status, 200);
    assert.equal(body.files.length, 1);
    const item = body.files[0];

    assert.equal(item.success, true);
    assert.equal(item.source, "csv_template", "must be routed through the generic template engine, not the legacy PDF/CSV shape");
    assert.equal(item.kind, "exact");
    assert.equal(item.templateName, `${prefix}-template`);
    assert.equal(item.templateVersion, 1);
    assert.ok(!("sizeBreakdown" in item), "must not carry the legacy FlowMaster preview shape");
    assert.ok(!("csvSizes" in item), "must not carry the legacy FlowMaster CSV parser's per-row shape");

    const preview = item.preview as { groups: Array<{ sizeKg: Record<string, number>; reconciliation: { recognizedSizeKg: number } }> };
    assert.equal(preview.groups.length, 1);
    assert.ok(preview.groups[0].reconciliation.recognizedSizeKg > 0, "must be a nonzero mapped result");
    const sizeNames = Object.keys(preview.groups[0].sizeKg);
    assert.ok(sizeNames.some((n) => n.startsWith("KgEntriesRoutingSmall")), "Class 1 must not be wiped out — the size must resolve");
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByOrgFilenamePrefix(DENVA_ORG_ID, prefix),
      () => cleanupPendingByOrgFilenamePrefix(DENVA_ORG_ID, prefix)
    );
  }
});

test("no match: a manual CSV upload with no matching template is queued for the Template Builder, not silently parsed by the legacy engine", async () => {
  const prefix = `kg-routing-none-${randomUUID()}`;
  const csv = `TotallyDifferent,Columns,Here\nfoo,bar,baz\n`;

  const { status, body } = await uploadCsvViaKgEntries(csv, `${prefix}.csv`);
  try {
    assert.equal(status, 200);
    const item = body.files[0];
    assert.equal(item.success, true);
    assert.equal(item.source, "csv_template");
    assert.equal(item.kind, "none");
    assert.ok(typeof item.pendingImportId === "string" && item.pendingImportId.length > 0);

    const { data: pendingRow } = await supabase.from("agent_pending_imports").select("needs_template, data_source_type, source_file_id").eq("id", item.pendingImportId as string).single();
    assert.equal(pendingRow?.needs_template, true);
    assert.equal(pendingRow?.data_source_type, "csv_template");
    assert.equal(pendingRow?.source_file_id, item.sourceFileId);
  } finally {
    await cleanupAll(
      () => cleanupPendingByOrgFilenamePrefix(DENVA_ORG_ID, prefix),
      () => cleanupSourceFilesByOrgFilenamePrefix(DENVA_ORG_ID, prefix)
    );
  }
});

test("cross-organization isolation: a CSV matching org A's template never auto-matches for org B", async () => {
  const prefix = `kg-routing-isolation-${randomUUID()}`;
  const csv = `Market,Size,Kg,Variety,Date\nClass 1,SM,7,Cadalora,15082026\n`;
  const uploaded = await previewManualCsvUpload(DENVA_ORG_ID, realOwnerUserId, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  const template = await createTemplate(DENVA_ORG_ID, realOwnerUserId, simpleWriteBody(uploaded.sourceFileId, `${prefix}-template`));

  try {
    const otherOrgResult = await previewManualCsvUpload(FIRST_LIGHT_ORG_ID, realOwnerUserId, { buffer: Buffer.from(csv), originalname: `${prefix}-other-org.csv` });
    assert.equal(otherOrgResult.kind, "none", "Denva's template must not leak into First Light's matching");
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByOrgFilenamePrefix(DENVA_ORG_ID, prefix),
      () => cleanupSourceFilesByOrgFilenamePrefix(FIRST_LIGHT_ORG_ID, prefix),
      () => cleanupPendingByOrgFilenamePrefix(DENVA_ORG_ID, prefix),
      () => cleanupPendingByOrgFilenamePrefix(FIRST_LIGHT_ORG_ID, prefix)
    );
  }
});

test("ambiguous match (defensive): the classification decision requires selection rather than guessing, if it ever sees >1 candidate", () => {
  // The live DB's partial unique index on (organization_id,
  // fingerprint_hash) where is_current and is_active makes two
  // current+active templates sharing a fingerprint impossible to create —
  // verified separately: even a direct SQL insert bypassing the app is
  // rejected with a 23505 unique-violation. So this exercises the pure
  // decision function classifyExactMatches directly (see its own doc
  // comment) rather than trying to manufacture unreachable database state.
  const candidates = [
    { id: "11111111-1111-1111-1111-111111111111", name: "Template A", version: 1 },
    { id: "22222222-2222-2222-2222-222222222222", name: "Template B", version: 3 }
  ];
  const result = classifyExactMatches(candidates);
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") {
    assert.deepEqual(result.candidates, candidates);
  }

  assert.equal(classifyExactMatches([candidates[0]]).kind, "exact");
  assert.equal(classifyExactMatches([]).kind, "none");
});

test("manual (Kg Entries) and Agent-equivalent matching produce the identical normalized preview for the same file and template", async () => {
  const prefix = `kg-routing-parity-${randomUUID()}`;
  const csv = `Market,Size,Kg,Variety,Date\nClass 1,SM,9.75,Cadalora,15082026\n`;
  const uploaded = await previewManualCsvUpload(DENVA_ORG_ID, realOwnerUserId, { buffer: Buffer.from(csv), originalname: `${prefix}.csv` });
  const template = await createTemplate(DENVA_ORG_ID, realOwnerUserId, simpleWriteBody(uploaded.sourceFileId, `${prefix}-template`));

  try {
    // "Manual" path — exactly what the Kg Entries route calls.
    const manualResult = await previewManualCsvUpload(DENVA_ORG_ID, realOwnerUserId, { buffer: Buffer.from(csv), originalname: `${prefix}-manual.csv` });
    assert.equal(manualResult.kind, "exact");

    // "Agent-equivalent" path — the same buildCsvPreview call the Agent's
    // own CSV-template branch makes once it has a sourceFileId + templateId.
    const agentEquivalentResult = await buildCsvPreview(DENVA_ORG_ID, { sourceFileId: uploaded.sourceFileId, templateId: template.id });

    if (manualResult.kind === "exact") {
      assert.deepEqual(manualResult.preview, agentEquivalentResult.preview, "manual and Agent paths must never disagree — they share the same service");
    }
  } finally {
    await cleanupAll(
      () => cleanupTemplateGroup(template.template_group_id),
      () => cleanupSourceFilesByOrgFilenamePrefix(DENVA_ORG_ID, prefix),
      () => cleanupPendingByOrgFilenamePrefix(DENVA_ORG_ID, prefix)
    );
  }
});

test("PDF upload through the same endpoint is completely unaffected by the CSV routing change", async () => {
  const fakePdf = Buffer.from(`%PDF-1.4\n%${randomUUID()}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`, "latin1");
  const form = new FormData();
  form.append("files", new Blob([fakePdf], { type: "application/pdf" }), `not-a-real-flowmaster-${randomUUID()}.pdf`);

  const res = await fetch(`${baseUrl}/api/pdf-import/preview`, { method: "POST", body: form });
  const body = (await res.json()) as { success: boolean; files: Array<Record<string, unknown>> };

  assert.equal(res.status, 200);
  assert.equal(body.files.length, 1);
  const item = body.files[0];
  // A non-FlowMaster-shaped PDF fails to parse (expected — this fixture
  // proves it went through the PDF branch and only the PDF branch, not
  // that this specific fake PDF is importable).
  assert.notEqual(item.source, "csv_template", "a PDF must never be routed through the CSV template engine");
});
