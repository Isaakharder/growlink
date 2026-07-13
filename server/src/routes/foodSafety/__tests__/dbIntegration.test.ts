import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../../../config/supabase";
import { orgScopedTable } from "../services/orgScopedTable";
import { ensureDepartmentExists } from "../locations";

// These tests exercise organization isolation and the employees foundation
// against a REAL Supabase project (using the same service-role client the
// server uses in production), rather than a mock. They require migrations
// 0074 (employees) and 0075 (food_safety_departments / food_safety_locations)
// to already be applied — see the migration commands in the implementation
// report. If the tables don't exist yet, every test in this file skips
// itself with a clear message instead of failing.
//
// Run with: npm run test:food-safety-db  (server/package.json)
//
// All rows created here are prefixed with a random run id and are deleted
// in the `after` hook (organizations cascade-delete their Food Safety rows
// and employees).

const RUN_ID = randomUUID().slice(0, 8);

let tablesReady = false;
let orgAId: string | null = null;
let orgBId: string | null = null;
let testUserId: string | null = null;

before(async () => {
  const { error } = await supabase.from("food_safety_departments").select("id").limit(1);
  if (error) {
    console.log(
      `[dbIntegration.test.ts] Skipping — food_safety_departments not queryable yet ` +
        `(${error.message}). Apply migrations 0074/0075 before running this suite.`
    );
    return;
  }

  const [orgA, orgB] = await Promise.all([
    supabase.from("organizations").insert({ name: `__fs_test_org_a_${RUN_ID}__` }).select("id").single(),
    supabase.from("organizations").insert({ name: `__fs_test_org_b_${RUN_ID}__` }).select("id").single()
  ]);

  if (orgA.error || orgB.error || !orgA.data || !orgB.data) {
    throw new Error(`Failed to seed test organizations: ${orgA.error?.message ?? orgB.error?.message}`);
  }

  orgAId = orgA.data.id as string;
  orgBId = orgB.data.id as string;
  tablesReady = true;
});

after(async () => {
  if (testUserId) {
    await supabase.auth.admin.deleteUser(testUserId).catch(() => undefined);
  }
  // Cascade deletes food_safety_departments / food_safety_locations / employees.
  if (orgAId) await supabase.from("organizations").delete().eq("id", orgAId);
  if (orgBId) await supabase.from("organizations").delete().eq("id", orgBId);
});

test("org A cannot read org B's department", async (t) => {
  if (!tablesReady) return t.skip("food_safety_departments not present — apply migrations 0074/0075 first");

  const { data: deptB, error } = await supabase
    .from("food_safety_departments")
    .insert({ organization_id: orgBId, name: `Org B Dept ${RUN_ID}` })
    .select("id")
    .single();
  assert.equal(error, null);

  const scopeA = orgScopedTable("food_safety_departments", orgAId as string);
  const { data: readAsOrgA } = await scopeA.selectById(deptB!.id as string);

  assert.equal(readAsOrgA, null, "org A must not be able to read a department belonging to org B");
});

test("org A cannot update org B's department", async (t) => {
  if (!tablesReady) return t.skip("food_safety_departments not present — apply migrations 0074/0075 first");

  const { data: deptB } = await supabase
    .from("food_safety_departments")
    .insert({ organization_id: orgBId, name: `Org B Dept Update ${RUN_ID}` })
    .select("id, name")
    .single();

  const scopeA = orgScopedTable("food_safety_departments", orgAId as string);
  const { data: updateResult } = await scopeA.update(deptB!.id as string, { name: "Hacked from org A" });
  assert.equal(updateResult, null, "cross-org update must not match any row");

  const { data: unchanged } = await supabase
    .from("food_safety_departments")
    .select("name")
    .eq("id", deptB!.id as string)
    .single();
  assert.equal(unchanged?.name, deptB!.name, "org B's department must be unchanged");
});

test("org A cannot read org B's location", async (t) => {
  if (!tablesReady) return t.skip("food_safety_locations not present — apply migrations 0074/0075 first");

  const { data: locationB, error } = await supabase
    .from("food_safety_locations")
    .insert({ organization_id: orgBId, name: `Org B Cooler ${RUN_ID}` })
    .select("id")
    .single();
  assert.equal(error, null);

  const scopeA = orgScopedTable("food_safety_locations", orgAId as string);
  const { data: readAsOrgA } = await scopeA.selectById(locationB!.id as string);

  assert.equal(readAsOrgA, null, "org A must not be able to read a location belonging to org B");
});

test("org A cannot assign an org B department to an org A location", async (t) => {
  if (!tablesReady) return t.skip("food_safety_departments not present — apply migrations 0074/0075 first");

  const { data: deptB } = await supabase
    .from("food_safety_departments")
    .insert({ organization_id: orgBId, name: `Org B Dept For Xorg Test ${RUN_ID}` })
    .select("id")
    .single();

  await assert.rejects(
    () => ensureDepartmentExists(deptB!.id as string, orgAId as string),
    /was not found in this organization/,
    "assigning a department from another organization must be rejected"
  );
});

test("employee_code is unique per organization, not globally", async (t) => {
  if (!tablesReady) return t.skip("employees not present — apply migration 0074 first");

  const { error: table404 } = await supabase.from("employees").select("id").limit(1);
  if (table404) return t.skip("employees table not present — apply migration 0074 first");

  const code = `EMP-${RUN_ID}`;

  const first = await supabase
    .from("employees")
    .insert({
      organization_id: orgAId,
      employee_code: code,
      first_name: "Alex",
      last_name: "Grower",
      display_name: "Alex Grower"
    })
    .select("id")
    .single();
  assert.equal(first.error, null);

  const duplicateSameOrg = await supabase.from("employees").insert({
    organization_id: orgAId,
    employee_code: code,
    first_name: "Sam",
    last_name: "Duplicate",
    display_name: "Sam Duplicate"
  });
  assert.notEqual(duplicateSameOrg.error, null, "duplicate employee_code within the same org must be rejected");

  const sameCodeOtherOrg = await supabase.from("employees").insert({
    organization_id: orgBId,
    employee_code: code,
    first_name: "Jamie",
    last_name: "OtherOrg",
    display_name: "Jamie OtherOrg"
  });
  assert.equal(sameCodeOtherOrg.error, null, "the same employee_code must be allowed in a different organization");
});

test("linked auth user_id is unique per organization", async (t) => {
  if (!tablesReady) return t.skip("employees not present — apply migration 0074 first");

  const { error: table404 } = await supabase.from("employees").select("id").limit(1);
  if (table404) return t.skip("employees table not present — apply migration 0074 first");

  const email = `fs-test-${RUN_ID}@example.invalid`;
  const { data: createdUser, error: createUserError } = await supabase.auth.admin.createUser({
    email,
    password: randomUUID(),
    email_confirm: true
  });

  if (createUserError || !createdUser?.user) {
    return t.skip(`Could not create a test auth user (${createUserError?.message}) — skipping user_id constraint check`);
  }

  testUserId = createdUser.user.id;

  const first = await supabase
    .from("employees")
    .insert({
      organization_id: orgAId,
      first_name: "Supervisor",
      last_name: "One",
      display_name: "Supervisor One",
      user_id: testUserId
    })
    .select("id")
    .single();
  assert.equal(first.error, null);

  const duplicate = await supabase.from("employees").insert({
    organization_id: orgAId,
    first_name: "Supervisor",
    last_name: "Two",
    display_name: "Supervisor Two",
    user_id: testUserId
  });
  assert.notEqual(duplicate.error, null, "the same user_id must not be linked to two employees in one organization");
});
