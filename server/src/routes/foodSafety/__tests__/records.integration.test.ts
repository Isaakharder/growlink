import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../../../config/supabase";
import { orgScopedTable } from "../services/orgScopedTable";
import { validateAnswers } from "../services/recordValidation";
import { getLatestPublishedVersion } from "../records";
import {
  RecordApiError,
  amendRecord,
  computeAnswerChanges,
  getRecordRow,
  listAuditEvents,
  listChanges,
  listRevisions,
  rejectRecord,
  resolveMetadataSnapshot,
  resubmitRecord,
  submitRecord,
  verifyRecord
} from "../services/recordRevisions";
import type { FoodSafetyRecordRow } from "../types";

// Phase 3 DB integration suite. Requires migration 0077 to be applied —
// every test skips itself with a clear message if the tables aren't
// queryable yet. Run with: npm run test:food-safety-records-db

const RUN_ID = randomUUID().slice(0, 8);

let tablesReady = false;
let orgAId: string;
let orgBId: string;
let departmentAId: string;
let locationAId: string;
let employeeA1Id: string; // completes records
let employeeA2Id: string; // supervisor, verifies records
let employeeBId: string; // belongs to org B

function schemaWithSelectors(requiresVerification: boolean) {
  return {
    schemaVersion: 1,
    title: `Test Form ${RUN_ID}`,
    workflow: { requiresVerification },
    sections: [
      {
        id: "s1",
        title: "Section 1",
        sortOrder: 0,
        fields: [
          { id: "notes", type: "short_text", label: "Notes", required: true, sortOrder: 0 },
          { id: "temp", type: "number", label: "Temp", required: false, sortOrder: 1 },
          {
            id: "who",
            type: "employee_selector",
            label: "Who",
            required: false,
            sortOrder: 2,
            config: { activeEmployeesOnly: true }
          },
          {
            id: "where",
            type: "location_asset_selector",
            label: "Where",
            required: false,
            sortOrder: 3
          }
        ]
      }
    ]
  };
}

async function createPublishedTemplate(
  organizationId: string,
  name: string,
  departmentId: string | null,
  schema: unknown,
  active = true
) {
  const { data: template, error: templateError } = await supabase
    .from("food_safety_form_templates")
    .insert({ organization_id: organizationId, name, department_id: departmentId, active })
    .select("*")
    .single();
  if (templateError) throw new Error(`Failed to seed template: ${templateError.message}`);

  const { data: version, error: versionError } = await supabase
    .from("food_safety_form_template_versions")
    .insert({
      organization_id: organizationId,
      template_id: template.id,
      version_number: 1,
      status: "published",
      schema_json: schema,
      published_at: new Date().toISOString()
    })
    .select("*")
    .single();
  if (versionError) throw new Error(`Failed to seed version: ${versionError.message}`);

  return { template, version };
}

async function createDraftRecord(
  organizationId: string,
  template: { id: string; department_id: string | null },
  version: { id: string },
  completedByUserId: string | null = null
): Promise<FoodSafetyRecordRow> {
  const { data, error } = await supabase
    .from("food_safety_records")
    .insert({
      organization_id: organizationId,
      template_id: template.id,
      template_version_id: version.id,
      department_id: template.department_id,
      status: "draft",
      answers_json: {},
      completed_by_user_id: completedByUserId,
      current_revision_number: 0
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to seed draft record: ${error.message}`);
  return data as FoodSafetyRecordRow;
}

async function snapshotFor(organizationId: string, record: FoodSafetyRecordRow, template: { name: string }) {
  return resolveMetadataSnapshot(organizationId, record, {
    templateName: template.name,
    formCode: null,
    canadagapSection: null,
    versionNumber: 1
  });
}

before(async () => {
  const { error } = await supabase.from("food_safety_records").select("id").limit(1);
  if (error) {
    console.log(
      `[records.integration.test.ts] Skipping — food_safety_records not queryable yet ` +
        `(${error.message}). Apply migration 0077 before running this suite.`
    );
    return;
  }

  const [orgA, orgB] = await Promise.all([
    supabase.from("organizations").insert({ name: `__fs_rec_test_org_a_${RUN_ID}__` }).select("id").single(),
    supabase.from("organizations").insert({ name: `__fs_rec_test_org_b_${RUN_ID}__` }).select("id").single()
  ]);
  if (orgA.error || orgB.error) throw new Error(`Failed to seed orgs: ${orgA.error?.message ?? orgB.error?.message}`);
  orgAId = orgA.data!.id;
  orgBId = orgB.data!.id;

  const [deptA] = await Promise.all([
    supabase.from("food_safety_departments").insert({ organization_id: orgAId, name: `Dept A ${RUN_ID}` }).select("id").single()
  ]);
  if (deptA.error) throw new Error(`Failed to seed department: ${deptA.error.message}`);
  departmentAId = deptA.data!.id;

  const locA = await supabase
    .from("food_safety_locations")
    .insert({ organization_id: orgAId, department_id: departmentAId, name: `Cooler A ${RUN_ID}`, location_type: "location" })
    .select("id")
    .single();
  if (locA.error) throw new Error(`Failed to seed location: ${locA.error.message}`);
  locationAId = locA.data!.id;

  const [empA1, empA2, empB] = await Promise.all([
    supabase
      .from("employees")
      .insert({ organization_id: orgAId, first_name: "A1", last_name: "Worker", display_name: `Worker A1 ${RUN_ID}`, active: true })
      .select("id")
      .single(),
    supabase
      .from("employees")
      .insert({ organization_id: orgAId, first_name: "A2", last_name: "Supervisor", display_name: `Supervisor A2 ${RUN_ID}`, active: true })
      .select("id")
      .single(),
    supabase
      .from("employees")
      .insert({ organization_id: orgBId, first_name: "B", last_name: "Worker", display_name: `Worker B ${RUN_ID}`, active: true })
      .select("id")
      .single()
  ]);
  if (empA1.error || empA2.error || empB.error) {
    throw new Error(`Failed to seed employees: ${empA1.error?.message ?? empA2.error?.message ?? empB.error?.message}`);
  }
  employeeA1Id = empA1.data!.id;
  employeeA2Id = empA2.data!.id;
  employeeBId = empB.data!.id;

  tablesReady = true;
});

after(async () => {
  if (orgAId) await supabase.from("organizations").delete().eq("id", orgAId);
  if (orgBId) await supabase.from("organizations").delete().eq("id", orgBId);
});

// ── organization isolation ──────────────────────────────────────────────────

test("org A cannot read org B's record", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgBId, `B Template ${RUN_ID}`, null, schemaWithSelectors(true));
  const record = await createDraftRecord(orgBId, template, version);

  const readAsOrgA = await getRecordRow(orgAId, record.id);
  assert.equal(readAsOrgA, null);
});

test("org A cannot access org B's revision or audit event history", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgBId, `B History ${RUN_ID}`, null, schemaWithSelectors(true));
  const record = await createDraftRecord(orgBId, template, version, null);
  const snapshot = await snapshotFor(orgBId, record, template);

  await submitRecord({
    organizationId: orgBId,
    recordId: record.id,
    answersJson: { notes: "hello" },
    completedByEmployeeId: employeeBId,
    completedByUserId: null,
    requiresVerification: true,
    metadataSnapshot: snapshot
  });

  const revisionsAsOrgA = await listRevisions(orgAId, record.id);
  const auditEventsAsOrgA = await listAuditEvents(orgAId, record.id);
  assert.deepEqual(revisionsAsOrgA, []);
  assert.deepEqual(auditEventsAsOrgA, []);
});

test("a cross-org employee_selector answer is rejected", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const schema = schemaWithSelectors(true) as any;
  const result = await validateAnswers(schema, { notes: "x", who: employeeBId }, orgAId, "submit");
  assert.equal(result.valid, false);
});

test("a cross-org location_asset_selector answer is rejected", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template: templateB } = await createPublishedTemplate(orgBId, `B Location Test ${RUN_ID}`, null, schemaWithSelectors(true));
  const locB = await supabase
    .from("food_safety_locations")
    .insert({ organization_id: orgBId, name: `B Location ${RUN_ID}`, location_type: "location" })
    .select("id")
    .single();

  const schema = schemaWithSelectors(true) as any;
  const result = await validateAnswers(schema, { notes: "x", where: locB.data!.id }, orgAId, "submit");
  assert.equal(result.valid, false);
  void templateB;
});

test("request-body organization_id cannot override context on record insert", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgAId, `Forged org test ${RUN_ID}`, departmentAId, schemaWithSelectors(true));
  const scope = orgScopedTable("food_safety_records", orgAId);
  const { data, error } = await scope.insert({
    template_id: template.id,
    template_version_id: version.id,
    status: "draft",
    answers_json: {},
    current_revision_number: 0,
    organization_id: orgBId // attempted override — must be ignored
  });

  assert.equal(error, null);
  assert.equal((data as { organization_id: string }).organization_id, orgAId);
});

// ── record creation / version resolution ────────────────────────────────────

test("getLatestPublishedVersion ignores drafts and returns only a published version", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template } = await supabase
    .from("food_safety_form_templates")
    .insert({ organization_id: orgAId, name: `Draft only ${RUN_ID}`, active: true })
    .select("*")
    .single()
    .then((r) => ({ template: r.data! }));

  await supabase.from("food_safety_form_template_versions").insert({
    organization_id: orgAId,
    template_id: template.id,
    version_number: 1,
    status: "draft",
    schema_json: schemaWithSelectors(true)
  });

  const noneYet = await getLatestPublishedVersion(orgAId, template.id);
  assert.equal(noneYet, null);

  await supabase.from("food_safety_form_template_versions").insert({
    organization_id: orgAId,
    template_id: template.id,
    version_number: 2,
    status: "published",
    schema_json: schemaWithSelectors(true),
    published_at: new Date().toISOString()
  });

  const published = await getLatestPublishedVersion(orgAId, template.id);
  assert.equal(published?.version_number, 2);
});

test("template_id must match the version's parent template (DB constraint)", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template: templateOne, version: versionOne } = await createPublishedTemplate(
    orgAId,
    `Mismatch 1 ${RUN_ID}`,
    null,
    schemaWithSelectors(true)
  );
  const { template: templateTwo } = await createPublishedTemplate(orgAId, `Mismatch 2 ${RUN_ID}`, null, schemaWithSelectors(true));
  void versionOne;

  const { error } = await supabase.from("food_safety_records").insert({
    organization_id: orgAId,
    template_id: templateTwo.id, // wrong template for this version
    template_version_id: versionOne.id,
    status: "draft",
    answers_json: {},
    current_revision_number: 0
  });

  assert.notEqual(error, null);
});

// ── submission, verification, rejection, resubmission, amendment ───────────

test("full lifecycle: draft -> submit -> verify, with revision + audit trail", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgAId, `Lifecycle ${RUN_ID}`, departmentAId, schemaWithSelectors(true));
  const record = await createDraftRecord(orgAId, template, version, null);

  // Draft validation allows incomplete required fields.
  const draftValidation = await validateAnswers(version.schema_json, {}, orgAId, "draft");
  assert.equal(draftValidation.valid, true);
  // Submission validation requires completeness.
  const submitValidation = await validateAnswers(version.schema_json, {}, orgAId, "submit");
  assert.equal(submitValidation.valid, false);

  const snapshot = await snapshotFor(orgAId, record, template);
  const submitted = await submitRecord({
    organizationId: orgAId,
    recordId: record.id,
    answersJson: { notes: "All clear", temp: 4 },
    completedByEmployeeId: employeeA1Id,
    completedByUserId: null,
    requiresVerification: true,
    metadataSnapshot: snapshot
  });
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.current_revision_number, 1);

  // Duplicate submit is rejected — the record is no longer a draft.
  await assert.rejects(
    () =>
      submitRecord({
        organizationId: orgAId,
        recordId: record.id,
        answersJson: { notes: "again" },
        completedByEmployeeId: employeeA1Id,
        completedByUserId: null,
        requiresVerification: true,
        metadataSnapshot: snapshot
      }),
    (err) => err instanceof RecordApiError && err.status === 409
  );

  const revisionsAfterSubmit = await listRevisions(orgAId, record.id);
  assert.equal(revisionsAfterSubmit.length, 1);
  assert.equal((revisionsAfterSubmit[0] as { status_snapshot: string }).status_snapshot, "submitted");

  const auditAfterSubmit = await listAuditEvents(orgAId, record.id);
  assert.ok(auditAfterSubmit.some((e: any) => e.event_type === "submitted"));

  // Schema snapshot preserved verbatim.
  const revisionDetail = (await supabase
    .from("food_safety_record_revisions")
    .select("template_schema_snapshot")
    .eq("record_id", record.id)
    .eq("revision_number", 1)
    .single()).data as { template_schema_snapshot: unknown };
  assert.deepEqual(revisionDetail.template_schema_snapshot, version.schema_json);

  // Self-verification is rejected.
  await assert.rejects(
    () =>
      verifyRecord({
        organizationId: orgAId,
        recordId: record.id,
        verifiedByUserId: null,
        verifiedByEmployeeId: employeeA1Id,
        metadataSnapshot: snapshot
      }),
    (err) => err instanceof RecordApiError && err.status === 403
  );

  const verified = await verifyRecord({
    organizationId: orgAId,
    recordId: record.id,
    verifiedByUserId: null,
    verifiedByEmployeeId: employeeA2Id,
    metadataSnapshot: snapshot
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.current_revision_number, 2);
  assert.equal(verified.verified_by_employee_id, employeeA2Id);
});

test("templates that do not require verification reach a final 'verified' state immediately", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgAId, `No verify ${RUN_ID}`, null, schemaWithSelectors(false));
  const record = await createDraftRecord(orgAId, template, version, null);
  const snapshot = await snapshotFor(orgAId, record, template);

  const submitted = await submitRecord({
    organizationId: orgAId,
    recordId: record.id,
    answersJson: { notes: "done" },
    completedByEmployeeId: employeeA1Id,
    completedByUserId: null,
    requiresVerification: false,
    metadataSnapshot: snapshot
  });

  assert.equal(submitted.status, "verified");
  assert.equal(submitted.verified_by_employee_id, null);
  assert.ok(submitted.verified_at);

  const auditEvents = await listAuditEvents(orgAId, record.id);
  const types = (auditEvents as Array<{ event_type: string }>).map((e) => e.event_type);
  assert.ok(types.includes("submitted"));
  assert.ok(types.includes("verified"));
});

test("rejection requires a reason, keeps the record readable, and resubmission preserves prior revisions", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgAId, `Reject flow ${RUN_ID}`, null, schemaWithSelectors(true));
  const record = await createDraftRecord(orgAId, template, version, null);
  const snapshot = await snapshotFor(orgAId, record, template);

  await submitRecord({
    organizationId: orgAId,
    recordId: record.id,
    answersJson: { notes: "first pass" },
    completedByEmployeeId: employeeA1Id,
    completedByUserId: null,
    requiresVerification: true,
    metadataSnapshot: snapshot
  });

  await assert.rejects(
    () =>
      rejectRecord({
        organizationId: orgAId,
        recordId: record.id,
        rejectedByUserId: null,
        rejectionReason: "",
        metadataSnapshot: snapshot
      }),
    (err) => err instanceof RecordApiError && err.status === 400
  );

  const rejected = await rejectRecord({
    organizationId: orgAId,
    recordId: record.id,
    rejectedByUserId: null,
    rejectionReason: "Missing temperature reading",
    metadataSnapshot: snapshot
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejection_reason, "Missing temperature reading");

  // Rejected record remains fully readable.
  const stillReadable = await getRecordRow(orgAId, record.id);
  assert.equal(stillReadable?.status, "rejected");

  const changes = computeAnswerChanges(rejected.answers_json, { notes: "corrected", temp: 2 });
  const resubmitted = await resubmitRecord({
    organizationId: orgAId,
    recordId: record.id,
    answersJson: { notes: "corrected", temp: 2 },
    completedByEmployeeId: employeeA1Id,
    completedByUserId: null,
    requiresVerification: true,
    changeReason: "Added the missing temperature reading",
    changes,
    metadataSnapshot: snapshot
  });
  assert.equal(resubmitted.status, "submitted");
  assert.equal(resubmitted.current_revision_number, 3); // 1 submit, 2 reject, 3 resubmit

  const changeRows = await listChanges(orgAId, record.id);
  assert.ok((changeRows as any[]).some((c) => c.field_id === "temp" && c.new_value === 2));

  // Old (rejected) revision is unchanged after resubmission.
  const oldRevision = (await supabase
    .from("food_safety_record_revisions")
    .select("answers_snapshot, status_snapshot")
    .eq("record_id", record.id)
    .eq("revision_number", 2)
    .single()).data as { answers_snapshot: Record<string, unknown>; status_snapshot: string };
  assert.equal(oldRevision.status_snapshot, "rejected");
  assert.deepEqual(oldRevision.answers_snapshot, { notes: "first pass" });
});

test("amendment requires a reason, invalidates prior verification, and preserves the old revision", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgAId, `Amend flow ${RUN_ID}`, null, schemaWithSelectors(true));
  const record = await createDraftRecord(orgAId, template, version, null);
  const snapshot = await snapshotFor(orgAId, record, template);

  await submitRecord({
    organizationId: orgAId,
    recordId: record.id,
    answersJson: { notes: "initial", temp: 3 },
    completedByEmployeeId: employeeA1Id,
    completedByUserId: null,
    requiresVerification: true,
    metadataSnapshot: snapshot
  });
  const verified = await verifyRecord({
    organizationId: orgAId,
    recordId: record.id,
    verifiedByUserId: null,
    verifiedByEmployeeId: employeeA2Id,
    metadataSnapshot: snapshot
  });
  assert.equal(verified.status, "verified");
  const verifiedRevisionNumber = verified.current_revision_number;

  await assert.rejects(
    () =>
      amendRecord({
        organizationId: orgAId,
        recordId: record.id,
        answersJson: { notes: "corrected", temp: 9 },
        amendedByEmployeeId: employeeA2Id,
        amendedByUserId: null,
        reason: "",
        changes: [],
        metadataSnapshot: snapshot
      }),
    (err) => err instanceof RecordApiError && err.status === 400
  );

  const changes = computeAnswerChanges(verified.answers_json, { notes: "corrected", temp: 9 });
  const amended = await amendRecord({
    organizationId: orgAId,
    recordId: record.id,
    answersJson: { notes: "corrected", temp: 9 },
    amendedByEmployeeId: employeeA2Id,
    amendedByUserId: null,
    reason: "Temperature was misread",
    changes,
    metadataSnapshot: snapshot
  });

  // Amendment invalidates verification and returns the record to
  // 'submitted' (awaiting verification) — not a separate 'amended' status.
  assert.equal(amended.status, "submitted");
  assert.equal(amended.verified_at, null);
  assert.equal(amended.verified_by_employee_id, null);
  assert.equal(amended.current_revision_number, verifiedRevisionNumber + 1);

  const changeRows = await listChanges(orgAId, record.id);
  assert.ok((changeRows as any[]).some((c) => c.field_id === "temp" && c.old_value === 3 && c.new_value === 9));

  const oldVerifiedRevision = (await supabase
    .from("food_safety_record_revisions")
    .select("answers_snapshot, status_snapshot")
    .eq("record_id", record.id)
    .eq("revision_number", verifiedRevisionNumber)
    .single()).data as { answers_snapshot: Record<string, unknown>; status_snapshot: string };
  assert.equal(oldVerifiedRevision.status_snapshot, "verified");
  assert.deepEqual(oldVerifiedRevision.answers_snapshot, { notes: "initial", temp: 3 });
});

// ── database guarantees ──────────────────────────────────────────────────────

test("revision rows are immutable — UPDATE and DELETE are rejected", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgAId, `Immutable ${RUN_ID}`, null, schemaWithSelectors(true));
  const record = await createDraftRecord(orgAId, template, version, null);
  const snapshot = await snapshotFor(orgAId, record, template);

  await submitRecord({
    organizationId: orgAId,
    recordId: record.id,
    answersJson: { notes: "x" },
    completedByEmployeeId: employeeA1Id,
    completedByUserId: null,
    requiresVerification: true,
    metadataSnapshot: snapshot
  });

  const updateResult = await supabase
    .from("food_safety_record_revisions")
    .update({ reason: "tampering attempt" })
    .eq("record_id", record.id)
    .eq("revision_number", 1);
  assert.notEqual(updateResult.error, null);

  const deleteResult = await supabase.from("food_safety_record_revisions").delete().eq("record_id", record.id).eq("revision_number", 1);
  assert.notEqual(deleteResult.error, null);
});

test("audit event rows are immutable — UPDATE and DELETE are rejected", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgAId, `Immutable Audit ${RUN_ID}`, null, schemaWithSelectors(true));
  const record = await createDraftRecord(orgAId, template, version, null);
  const snapshot = await snapshotFor(orgAId, record, template);

  await submitRecord({
    organizationId: orgAId,
    recordId: record.id,
    answersJson: { notes: "x" },
    completedByEmployeeId: employeeA1Id,
    completedByUserId: null,
    requiresVerification: true,
    metadataSnapshot: snapshot
  });

  const events = await listAuditEvents(orgAId, record.id);
  const eventId = (events[0] as { id: string }).id;

  const updateResult = await supabase.from("food_safety_record_audit_events").update({ event_metadata: {} }).eq("id", eventId);
  assert.notEqual(updateResult.error, null);

  const deleteResult = await supabase.from("food_safety_record_audit_events").delete().eq("id", eventId);
  assert.notEqual(deleteResult.error, null);
});

test("an invalid record status is rejected by the database CHECK constraint", async (t) => {
  if (!tablesReady) return t.skip("migration 0077 not applied yet");

  const { template, version } = await createPublishedTemplate(orgAId, `Bad status ${RUN_ID}`, null, schemaWithSelectors(true));
  const { error } = await supabase.from("food_safety_records").insert({
    organization_id: orgAId,
    template_id: template.id,
    template_version_id: version.id,
    status: "not-a-real-status",
    answers_json: {},
    current_revision_number: 0
  });
  assert.notEqual(error, null);
});
