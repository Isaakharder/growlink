import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../../../config/supabase";
import { orgScopedTable } from "../services/orgScopedTable";
import { ensureDepartmentExists } from "../locations";
import {
  TemplateApiError,
  cloneVersion,
  createFirstVersion,
  ensureTemplateExists,
  getVersionRow,
  listVersionSummaries,
  publishVersion,
  updateDraftVersion
} from "../services/templateVersioning";

// Phase 2 equivalent of dbIntegration.test.ts (Phase 1): exercises template/
// version organization isolation and the versioning lifecycle against a REAL
// Supabase project via the service-role client, rather than mocks. Requires
// migration 0076 to be applied — every test skips itself with a clear
// message if the tables aren't queryable yet.
//
// Run with: npm run test:food-safety-templates-db

const RUN_ID = randomUUID().slice(0, 8);

let tablesReady = false;
let orgAId: string;
let orgBId: string;
let departmentAId: string;
let departmentBId: string;

function validSchema(title: string) {
  return {
    schemaVersion: 1,
    title,
    description: "",
    instructions: "",
    sections: [
      {
        id: "section_1",
        title: "Section 1",
        sortOrder: 0,
        fields: [{ id: "field_1", type: "pass_fail", label: "Check complete", required: true, sortOrder: 0 }]
      }
    ]
  };
}

async function createTemplate(organizationId: string, name: string, departmentId: string | null = null) {
  const { data, error } = await supabase
    .from("food_safety_form_templates")
    .insert({ organization_id: organizationId, name, department_id: departmentId })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to seed template: ${error.message}`);
  return data as { id: string; name: string };
}

before(async () => {
  const { error } = await supabase.from("food_safety_form_templates").select("id").limit(1);
  if (error) {
    console.log(
      `[templates.integration.test.ts] Skipping — food_safety_form_templates not queryable yet ` +
        `(${error.message}). Apply migration 0076 before running this suite.`
    );
    return;
  }

  const [orgA, orgB] = await Promise.all([
    supabase.from("organizations").insert({ name: `__fs_tmpl_test_org_a_${RUN_ID}__` }).select("id").single(),
    supabase.from("organizations").insert({ name: `__fs_tmpl_test_org_b_${RUN_ID}__` }).select("id").single()
  ]);
  if (orgA.error || orgB.error || !orgA.data || !orgB.data) {
    throw new Error(`Failed to seed test organizations: ${orgA.error?.message ?? orgB.error?.message}`);
  }
  orgAId = orgA.data.id as string;
  orgBId = orgB.data.id as string;

  const [deptA, deptB] = await Promise.all([
    supabase.from("food_safety_departments").insert({ organization_id: orgAId, name: `Dept A ${RUN_ID}` }).select("id").single(),
    supabase.from("food_safety_departments").insert({ organization_id: orgBId, name: `Dept B ${RUN_ID}` }).select("id").single()
  ]);
  if (deptA.error || deptB.error || !deptA.data || !deptB.data) {
    throw new Error(`Failed to seed test departments: ${deptA.error?.message ?? deptB.error?.message}`);
  }
  departmentAId = deptA.data.id as string;
  departmentBId = deptB.data.id as string;

  tablesReady = true;
});

after(async () => {
  if (orgAId) await supabase.from("organizations").delete().eq("id", orgAId);
  if (orgBId) await supabase.from("organizations").delete().eq("id", orgBId);
});

// ── organization isolation ──────────────────────────────────────────────────

test("org A cannot read org B's template", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const templateB = await createTemplate(orgBId, `B Template ${RUN_ID}`);

  await assert.rejects(() => ensureTemplateExists(orgAId, templateB.id), (err) => err instanceof TemplateApiError && err.status === 404);
});

test("org A cannot read org B's version", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const templateB = await createTemplate(orgBId, `B Template Version ${RUN_ID}`);
  const versionB = await createFirstVersion(orgBId, templateB.id, validSchema("B form"), null, null);

  const readAsOrgA = await getVersionRow(orgAId, templateB.id, versionB.id);
  assert.equal(readAsOrgA, null);
});

test("org A cannot assign org B's department to a template", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const { error } = await supabase
    .from("food_safety_form_templates")
    .insert({ organization_id: orgAId, name: `Should fail ${RUN_ID}`, department_id: departmentBId })
    .select("id")
    .single();

  // The raw insert itself isn't blocked by a DB constraint (department_id has
  // no organization-aware FK check possible in SQL alone) — cross-org
  // assignment is rejected at the application layer by
  // ensureDepartmentExists(), exercised here the same way templates.ts calls
  // it. This assertion documents that the DB alone does NOT enforce it, and
  // the next assertion proves the app-layer guard does.
  assert.equal(error, null);

  await assert.rejects(() => ensureDepartmentExists(departmentBId, orgAId), /was not found in this organization/);
});

test("org A cannot access a version through a mismatched template id (same org)", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const templateA1 = await createTemplate(orgAId, `A1 ${RUN_ID}`);
  const templateA2 = await createTemplate(orgAId, `A2 ${RUN_ID}`);
  const versionA1 = await createFirstVersion(orgAId, templateA1.id, validSchema("A1 form"), null, null);

  const readThroughWrongTemplate = await getVersionRow(orgAId, templateA2.id, versionA1.id);
  assert.equal(readThroughWrongTemplate, null);
});

test("request-body organization_id cannot override the request organization on insert", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const scope = orgScopedTable("food_safety_form_templates", orgAId);
  const { data, error } = await scope.insert({
    name: `Forged org test ${RUN_ID}`,
    organization_id: orgBId // attempted override — must be ignored
  });

  assert.equal(error, null);
  assert.equal((data as { organization_id: string }).organization_id, orgAId);
});

test("a location_asset_selector referencing another org's department is rejected when creating a version", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const template = await createTemplate(orgAId, `Cross-org field test ${RUN_ID}`);
  const schema = validSchema("Cross-org field form");
  schema.sections[0].fields.push({
    id: "field_2",
    type: "location_asset_selector",
    label: "Cooler",
    required: false,
    sortOrder: 1,
    config: { filterDepartmentId: departmentBId }
  } as any);

  await assert.rejects(
    () => createFirstVersion(orgAId, template.id, schema, null, null),
    (err) => err instanceof TemplateApiError && err.status === 400
  );
});

// ── versioning lifecycle ─────────────────────────────────────────────────────

test("full draft -> publish -> clone lifecycle", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const template = await createTemplate(orgAId, `Lifecycle ${RUN_ID}`, departmentAId);

  const v1 = await createFirstVersion(orgAId, template.id, validSchema("v1"), "first draft", null);
  assert.equal(v1.version_number, 1);
  assert.equal(v1.status, "draft");

  // Creating a first version again must be rejected — a version already exists.
  await assert.rejects(
    () => createFirstVersion(orgAId, template.id, validSchema("v1 again"), null, null),
    (err) => err instanceof TemplateApiError && err.status === 409
  );

  // Drafts can be edited.
  const updated = await updateDraftVersion(orgAId, template.id, v1.id, validSchema("v1 edited"), "edited notes");
  assert.equal((updated.schema_json as { title: string }).title, "v1 edited");

  // Publish freezes it.
  const published = await publishVersion(orgAId, template.id, v1.id, null);
  assert.equal(published.status, "published");
  assert.ok(published.published_at);

  // Published versions cannot be edited.
  await assert.rejects(
    () => updateDraftVersion(orgAId, template.id, v1.id, validSchema("hacked"), null),
    (err) => err instanceof TemplateApiError && err.status === 409
  );

  // Publishing again is rejected — it is no longer a draft.
  await assert.rejects(
    () => publishVersion(orgAId, template.id, v1.id, null),
    (err) => err instanceof TemplateApiError && err.status === 409
  );

  // Cloning creates the next version as a new draft, copying the published schema.
  const v2 = await cloneVersion(orgAId, template.id, v1.id, null);
  assert.equal(v2.version_number, 2);
  assert.equal(v2.status, "draft");
  assert.equal((v2.schema_json as { title: string }).title, "v1 edited");
  assert.match(v2.version_notes ?? "", /Cloned from version 1/);

  // The old published version is untouched by the clone.
  const stillPublished = await getVersionRow(orgAId, template.id, v1.id);
  assert.equal(stillPublished?.status, "published");
  assert.equal((stillPublished?.schema_json as { title: string }).title, "v1 edited");

  // Only one draft per template — cloning again while v2 is still a draft is rejected.
  await assert.rejects(
    () => cloneVersion(orgAId, template.id, v1.id, null),
    (err) => err instanceof TemplateApiError && err.status === 409
  );

  // Deactivating the template must not remove its version history.
  await supabase.from("food_safety_form_templates").update({ active: false }).eq("id", template.id);
  const versions = await listVersionSummaries(orgAId, template.id);
  assert.equal(versions.length, 2);
});

test("duplicate version_number is rejected at the database level", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const template = await createTemplate(orgAId, `Dup version ${RUN_ID}`);
  await createFirstVersion(orgAId, template.id, validSchema("v1"), null, null);

  const { error } = await supabase.from("food_safety_form_template_versions").insert({
    organization_id: orgAId,
    template_id: template.id,
    version_number: 1,
    status: "archived",
    schema_json: validSchema("duplicate")
  });

  assert.notEqual(error, null);
  assert.equal((error as { code?: string }).code, "23505");
});

test("only one draft version may exist per template (database constraint)", async (t) => {
  if (!tablesReady) return t.skip("migration 0076 not applied yet");

  const template = await createTemplate(orgAId, `One draft ${RUN_ID}`);
  await createFirstVersion(orgAId, template.id, validSchema("v1"), null, null);

  // Bypassing the app-layer check entirely and inserting a second draft
  // directly — the partial unique index must still block it.
  const { error } = await supabase.from("food_safety_form_template_versions").insert({
    organization_id: orgAId,
    template_id: template.id,
    version_number: 2,
    status: "draft",
    schema_json: validSchema("second draft")
  });

  assert.notEqual(error, null);
  assert.equal((error as { code?: string }).code, "23505");
});
