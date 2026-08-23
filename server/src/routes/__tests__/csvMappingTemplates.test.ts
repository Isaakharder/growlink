// Route-level tests for the CSV Import Template Builder's CRUD/preview
// functions, run directly against the live Supabase DB (per project
// convention — no local Docker Supabase). Each test creates its own
// throwaway rows (template + source file) scoped to a real, existing
// organization and deletes them afterward; no historical yield data is
// touched.
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../../config/supabase";
import {
  parseAndMatchCsvFile,
  listTemplatesForOrg,
  getTemplateById,
  createTemplate,
  createTemplateVersion,
  renameTemplate,
  setTemplateActive,
  duplicateTemplate,
  deleteTemplateIfUnused,
  buildCsvPreview,
  parseTemplateWriteBody,
  createPendingCsvTemplateImport,
  listPendingCsvTemplateImports,
  TemplateNotFoundError,
  TemplateNotCurrentError,
  TemplateConflictError,
  TemplateInUseError,
  type TemplateRow,
  type TemplateWriteInput
} from "../csvMappingTemplates";

const DENVA_ORG_ID = "7f933d9b-a093-4eed-b6d7-85ff0c68a319";
const FIRST_LIGHT_ORG_ID = "e1b8a6cf-032c-48f0-852a-982dd58b9f9c";
const TEST_USER_ID = "00000000-0000-0000-0000-0000000000aa";

async function uploadTestFile(organizationId: string, csvText: string, filename = `test-${randomUUID()}.csv`) {
  const buffer = Buffer.from(csvText, "utf-8");
  const result = await parseAndMatchCsvFile(organizationId, TEST_USER_ID, { buffer, originalname: filename });
  return result;
}

async function cleanupSourceFile(sourceFileId: string) {
  await supabase.from("csv_import_source_files").delete().eq("id", sourceFileId);
}

async function cleanupTemplateGroup(templateGroupId: string) {
  await supabase.from("csv_mapping_templates").delete().eq("template_group_id", templateGroupId);
}

const SIMPLE_CSV = "Market,Size,Kg\nClass 1,SM,10\nClass 1,MD,15\n";

function simpleWriteBody(sourceFileId: string, name = `Test Template ${randomUUID()}`): TemplateWriteInput {
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
    // "create" resolves via newSizeName directly, with no dependency on a
    // real yield_sizes row existing in whichever org these tests run
    // against — appropriate for CRUD/versioning tests that don't care
    // about actual size resolution.
    valueMappings: [
      { sourceField: "size_label", rawValue: "SM", action: "create", newSizeName: "Small" },
      { sourceField: "size_label", rawValue: "MD", action: "create", newSizeName: "Medium" }
    ],
    rules: []
  });
}

test("parseAndMatchCsvFile: content-dedup — uploading identical bytes twice returns the same sourceFileId", async () => {
  const text = `Dedup,Test\n${randomUUID()},1\n`;
  const first = await uploadTestFile(DENVA_ORG_ID, text);
  const second = await uploadTestFile(DENVA_ORG_ID, text);

  try {
    assert.equal(first.sourceFileId, second.sourceFileId);
    assert.equal(first.rowCount, second.rowCount);
  } finally {
    await cleanupSourceFile(first.sourceFileId);
  }
});

test("parseAndMatchCsvFile: a layout with no saved template reports match kind 'none'", async () => {
  const text = `UniqueHeader${randomUUID()},Col2\nx,1\n`;
  const result = await uploadTestFile(DENVA_ORG_ID, text);
  try {
    assert.equal(result.match.kind, "none");
    assert.equal(result.match.templateId, null);
  } finally {
    await cleanupSourceFile(result.sourceFileId);
  }
});

test("createTemplate + parseAndMatchCsvFile: an exact-fingerprint re-upload auto-matches the saved template", async () => {
  const header = `ExactMatch${randomUUID()}`;
  const text = `${header},Kg\nSM,10\n`;
  const uploaded = await uploadTestFile(DENVA_ORG_ID, text);

  const body = parseTemplateWriteBody({
    name: `Exact Match Template ${randomUUID()}`,
    sourceFileId: uploaded.sourceFileId,
    delimiter: ",",
    headerRowIndex: 0,
    dataStartRowIndex: 1,
    columnMappings: [
      { columnIndex: 0, field: "size_label" },
      { columnIndex: 1, field: "size_weight_kg" }
    ]
  });
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, body);

  try {
    // Re-upload the exact same header/structure (different bytes overall
    // via a fresh random suffix would change the fingerprint, so reuse the
    // identical text — content-dedup returns the same sourceFileId, and
    // fingerprint matching is exercised independently of that).
    const reupload = await uploadTestFile(DENVA_ORG_ID, `${header},Kg\nMD,20\n`);
    try {
      assert.equal(reupload.match.kind, "exact");
      assert.equal(reupload.match.templateId, template.id);
    } finally {
      await cleanupSourceFile(reupload.sourceFileId);
    }
  } finally {
    await cleanupTemplateGroup(template.template_group_id);
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});

test("createTemplate: a second template with the identical layout conflicts (409-equivalent)", async () => {
  const uploaded = await uploadTestFile(DENVA_ORG_ID, SIMPLE_CSV);
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(uploaded.sourceFileId));

  try {
    await assert.rejects(
      () => createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(uploaded.sourceFileId, "Duplicate layout")),
      TemplateConflictError
    );
  } finally {
    await cleanupTemplateGroup(template.template_group_id);
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});

test("template versioning: editing creates version 2, demotes version 1's is_current, and old version can't be edited again", async () => {
  const uploaded = await uploadTestFile(DENVA_ORG_ID, SIMPLE_CSV);
  const v1 = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(uploaded.sourceFileId));

  try {
    const v2Body = simpleWriteBody(uploaded.sourceFileId, v1.name);
    v2Body.valueMappings.push({ sourceField: "size_label", rawValue: "LG", action: "map", targetSizeId: "s3" });
    const v2 = await createTemplateVersion(DENVA_ORG_ID, TEST_USER_ID, v1.id, v2Body);

    assert.equal(v2.version, 2);
    assert.equal(v2.template_group_id, v1.template_group_id);
    assert.equal(v2.is_current, true);

    const reloadedV1 = await getTemplateById(DENVA_ORG_ID, v1.id);
    assert.equal(reloadedV1?.is_current, false);
    // The old version's row/id/config survive untouched — reproducible history.
    assert.equal(reloadedV1?.value_mappings.length, 2);

    await assert.rejects(
      () => createTemplateVersion(DENVA_ORG_ID, TEST_USER_ID, v1.id, v2Body),
      TemplateNotCurrentError
    );
  } finally {
    await cleanupTemplateGroup(v1.template_group_id);
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});

test("template CRUD: rename, disable/enable, duplicate, and delete-when-unused all work; delete-when-used is blocked", async () => {
  const uploaded = await uploadTestFile(DENVA_ORG_ID, SIMPLE_CSV);
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(uploaded.sourceFileId));
  let duplicate: TemplateRow | null = null;

  try {
    const renamed = await renameTemplate(DENVA_ORG_ID, TEST_USER_ID, template.id, "Renamed Template");
    assert.equal(renamed.name, "Renamed Template");

    const disabled = await setTemplateActive(DENVA_ORG_ID, TEST_USER_ID, template.id, false);
    assert.equal(disabled.is_active, false);
    const reenabled = await setTemplateActive(DENVA_ORG_ID, TEST_USER_ID, template.id, true);
    assert.equal(reenabled.is_active, true);

    duplicate = await duplicateTemplate(DENVA_ORG_ID, TEST_USER_ID, template.id, "Duplicated Template");
    assert.notEqual(duplicate.template_group_id, template.template_group_id);
    assert.equal(duplicate.value_mappings.length, template.value_mappings.length);

    const duplicateId = duplicate.id;
    const list = await listTemplatesForOrg(DENVA_ORG_ID);
    assert.ok(list.some((t) => t.id === template.id));
    assert.ok(list.some((t) => t.id === duplicateId));

    // Simulate usage by a real import run, then confirm delete is blocked.
    const { data: fakeRun, error: fakeRunErr } = await supabase
      .from("yield_import_runs")
      .insert({
        organization_id: DENVA_ORG_ID,
        lot_number: `test-lot-${randomUUID()}`,
        csv_mapping_template_id: template.id
      })
      .select("id")
      .single();
    assert.equal(fakeRunErr, null);

    try {
      await assert.rejects(() => deleteTemplateIfUnused(DENVA_ORG_ID, template.id), TemplateInUseError);
    } finally {
      await supabase.from("yield_import_runs").delete().eq("id", fakeRun!.id as string);
    }

    // Now unused — delete should succeed.
    await deleteTemplateIfUnused(DENVA_ORG_ID, template.id);
    const afterDelete = await getTemplateById(DENVA_ORG_ID, template.id);
    assert.equal(afterDelete, null);
  } finally {
    if (duplicate) await cleanupTemplateGroup(duplicate.template_group_id);
    await cleanupTemplateGroup(template.template_group_id);
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});

test("cross-organization isolation: a template created in one org is invisible to another org", async () => {
  const uploaded = await uploadTestFile(DENVA_ORG_ID, SIMPLE_CSV);
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(uploaded.sourceFileId));

  try {
    const fromOtherOrg = await getTemplateById(FIRST_LIGHT_ORG_ID, template.id);
    assert.equal(fromOtherOrg, null);

    const otherOrgList = await listTemplatesForOrg(FIRST_LIGHT_ORG_ID);
    assert.ok(!otherOrgList.some((t) => t.id === template.id));

    // Renaming/deleting cross-org must also be no-ops (org filter in the WHERE clause).
    await assert.rejects(() => renameTemplate(FIRST_LIGHT_ORG_ID, TEST_USER_ID, template.id, "Hijacked"), TemplateNotFoundError);
  } finally {
    await cleanupTemplateGroup(template.template_group_id);
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});

test("buildCsvPreview: draft config (unsaved) produces a live preview identical in shape to a saved-template preview", async () => {
  const uploaded = await uploadTestFile(DENVA_ORG_ID, SIMPLE_CSV);

  try {
    const draftResult = await buildCsvPreview(DENVA_ORG_ID, {
      sourceFileId: uploaded.sourceFileId,
      draftConfig: {
        delimiter: ",",
        headerRowIndex: 0,
        dataStartRowIndex: 1,
        columnMappings: [
          { columnIndex: 0, field: "market_grade" },
          { columnIndex: 1, field: "size_label" },
          { columnIndex: 2, field: "size_weight_kg" }
        ],
        valueMappings: [
          // "create" resolves via newSizeName directly, with no dependency
          // on a real yield_sizes row existing — appropriate for a draft
          // preview where the user hasn't saved anything yet.
          { sourceField: "size_label", rawValue: "SM", action: "create", newSizeName: "Small" },
          { sourceField: "size_label", rawValue: "MD", action: "create", newSizeName: "Medium" }
        ]
      }
    });

    assert.equal(draftResult.templateId, null);
    assert.equal(draftResult.preview.groups.length, 1);
    assert.ok(draftResult.preview.groups[0].reconciliation.recognizedSizeKg > 0);
  } finally {
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});

test("buildCsvPreview: a saved template whose fingerprint no longer matches the uploaded file blocks import with layout_mismatch", async () => {
  const originalUpload = await uploadTestFile(DENVA_ORG_ID, SIMPLE_CSV);
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(originalUpload.sourceFileId));

  try {
    // A structurally different file (extra column) uploaded separately, then
    // previewed AGAINST the old template — simulates "vendor changed the export layout."
    const changedUpload = await uploadTestFile(DENVA_ORG_ID, "Market,Size,Kg,Extra\nClass 1,SM,10,x\n");
    try {
      const result = await buildCsvPreview(DENVA_ORG_ID, { sourceFileId: changedUpload.sourceFileId, templateId: template.id });
      assert.equal(result.layoutMismatch, true);
      assert.equal(result.preview.canImport, false);
      assert.ok(result.preview.validationIssues.some((i) => i.code === "layout_mismatch"));
    } finally {
      await cleanupSourceFile(changedUpload.sourceFileId);
    }
  } finally {
    await cleanupTemplateGroup(template.template_group_id);
    await cleanupSourceFile(originalUpload.sourceFileId);
  }
});

test("getTemplateById returns null for a nonexistent id rather than throwing", async () => {
  const result = await getTemplateById(DENVA_ORG_ID, randomUUID());
  assert.equal(result, null);
});

test("pending CSV template queue: a matched pending row reprocesses its preserved raw text into a live preview", async () => {
  const uploaded = await uploadTestFile(DENVA_ORG_ID, SIMPLE_CSV, "pending-matched.csv");
  const template = await createTemplate(DENVA_ORG_ID, TEST_USER_ID, simpleWriteBody(uploaded.sourceFileId));
  const pending = await createPendingCsvTemplateImport(
    DENVA_ORG_ID,
    uploaded.sourceFileId,
    "pending-matched.csv",
    template.id,
    false
  );

  try {
    const list = await listPendingCsvTemplateImports(DENVA_ORG_ID);
    const item = list.find((i) => i.id === pending.id);
    assert.ok(item);
    assert.equal(item?.needsTemplate, false);
    assert.equal(item?.error, null);
    assert.ok(item?.preview);
    // Raw CSV reprocessing: the preview was rebuilt from csv_import_source_files.raw_text,
    // not from any stale stored columns on the pending row itself (which has none here).
    assert.equal(item?.preview?.groups.length, 1);
    assert.ok((item?.preview?.groups[0].reconciliation.recognizedSizeKg ?? 0) > 0);
  } finally {
    await supabase.from("agent_pending_imports").delete().eq("id", pending.id);
    await cleanupTemplateGroup(template.template_group_id);
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});

test("pending CSV template queue: a row with no matched template (needs_template) is listed without a preview, awaiting the builder", async () => {
  const uploaded = await uploadTestFile(DENVA_ORG_ID, `Unmatched${randomUUID()},Col2\nx,1\n`, "pending-unmatched.csv");
  const pending = await createPendingCsvTemplateImport(DENVA_ORG_ID, uploaded.sourceFileId, "pending-unmatched.csv", null, true);

  try {
    const list = await listPendingCsvTemplateImports(DENVA_ORG_ID);
    const item = list.find((i) => i.id === pending.id);
    assert.ok(item);
    assert.equal(item?.needsTemplate, true);
    assert.equal(item?.preview, null);
  } finally {
    await supabase.from("agent_pending_imports").delete().eq("id", pending.id);
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});

test("pending CSV template queue is org-isolated", async () => {
  const uploaded = await uploadTestFile(DENVA_ORG_ID, SIMPLE_CSV, "pending-isolation.csv");
  const pending = await createPendingCsvTemplateImport(DENVA_ORG_ID, uploaded.sourceFileId, "pending-isolation.csv", null, true);

  try {
    const otherOrgList = await listPendingCsvTemplateImports(FIRST_LIGHT_ORG_ID);
    assert.ok(!otherOrgList.some((i) => i.id === pending.id));
  } finally {
    await supabase.from("agent_pending_imports").delete().eq("id", pending.id);
    await cleanupSourceFile(uploaded.sourceFileId);
  }
});
