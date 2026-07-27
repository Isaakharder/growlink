-- One-off cleanup, requested 2026-07-27 for First Light Greenhouses inc:
--
--   1. Wipe ALL historical Food Safety reports (and their in-progress
--      checklists) for the "Washroom 1" location so it reads as freshly
--      configured with 0 reports. The location row and its configured
--      tasks are left completely untouched.
--
--   2. Hard-delete every Food Safety test location (name starts with
--      "ZZ_", case-insensitive -- ZZ_BACKDATE_TEST_*, ZZ_OFFLINE_BACKDATE_*,
--      ZZ_OFFLINE_BACKDATE_INVALID_*, ZZ_RECHECK_*, and any future one
--      following the same convention), plus every report/checklist/task
--      row that belongs to them.
--
-- IMPORTANT -- this overrides a deliberate safeguard. food_safety_cleaning_
-- reports and food_safety_cleaning_report_items carry a trigger (migrations
-- 0088/0090) that unconditionally rejects UPDATE/DELETE so completed Food
-- Safety reports can never be edited or disappear -- by design, not by
-- accident. This script disables that trigger for the duration of one
-- transaction, deletes the targeted rows, and re-enables it before commit.
-- If anything in the transaction errors, disabling the trigger rolls back
-- too, so the safeguard is never left off. There is no other supported way
-- to remove rows from these two tables.
--
-- Everything below is scoped to the "First Light Greenhouses inc"
-- organization by id, resolved by name, so no other tenant's data can be
-- touched even if another org happens to have a location also named
-- "Washroom 1" or a stray "ZZ_"-prefixed location.
--
-- Not safe to run twice for meaningful effect (the second run is a no-op:
-- Washroom 1 already has 0 reports, and the test locations are already
-- gone), but harmless to re-run.


-- =========================================================================
-- STEP 1 -- PREVIEW (read-only). Run this first and confirm the rows
-- listed below are exactly what you expect before running Step 2.
-- =========================================================================

-- Org being targeted.
select id as organization_id, name
from public.organizations
where name = 'First Light Greenhouses inc';

-- Washroom 1: confirm there is exactly one match, and see its current
-- report/checklist counts.
select
  l.id as location_id,
  l.name,
  l.area,
  l.is_active,
  (select count(*) from public.food_safety_cleaning_reports r where r.location_id = l.id) as report_count,
  (select count(*) from public.food_safety_cleaning_checklists c where c.location_id = l.id) as checklist_count
from public.food_safety_cleaning_locations l
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and lower(l.name) = 'washroom 1';

-- Test locations that will be permanently deleted, with their current
-- report/checklist/task counts.
select
  l.id as location_id,
  l.name,
  l.area,
  l.is_active,
  (select count(*) from public.food_safety_cleaning_reports r where r.location_id = l.id) as report_count,
  (select count(*) from public.food_safety_cleaning_checklists c where c.location_id = l.id) as checklist_count,
  (select count(*) from public.food_safety_cleaning_tasks t where t.location_id = l.id) as task_count
from public.food_safety_cleaning_locations l
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and l.name ~* '^zz_'
order by l.name;


-- =========================================================================
-- STEP 2 -- CLEANUP (destructive). Only run after reviewing Step 1.
-- =========================================================================

begin;

create temporary table food_safety_cleanup_summary (
  step text,
  detail text,
  row_count integer
) on commit preserve rows;

do $$
declare
  v_org_id uuid;
  v_washroom1_id uuid;
  v_test_ids uuid[];
  v_test_count integer;
  v_washroom1_reports_before integer;
  v_washroom1_checklists_before integer;
  v_test_reports_before integer;
  v_test_checklists_before integer;
  v_deleted integer;
begin
  -- Resolve the organization by name; hard-stop if it's not exactly one row
  -- so this can never silently run against the wrong tenant.
  select id into v_org_id
  from public.organizations
  where name = 'First Light Greenhouses inc';

  if v_org_id is null then
    raise exception 'Organization "First Light Greenhouses inc" not found -- aborting.';
  end if;

  if (select count(*) from public.organizations where name = 'First Light Greenhouses inc') > 1 then
    raise exception 'More than one organization named "First Light Greenhouses inc" -- aborting, resolve ambiguity manually.';
  end if;

  -- Resolve Washroom 1; hard-stop unless there's exactly one match.
  select id into v_washroom1_id
  from public.food_safety_cleaning_locations
  where organization_id = v_org_id
    and lower(name) = 'washroom 1';

  if v_washroom1_id is null then
    raise exception 'Washroom 1 location not found for this organization -- aborting.';
  end if;

  if (select count(*) from public.food_safety_cleaning_locations where organization_id = v_org_id and lower(name) = 'washroom 1') > 1 then
    raise exception 'More than one "Washroom 1" location found -- aborting, resolve ambiguity manually.';
  end if;

  -- Resolve every test location (ZZ_ prefix, case-insensitive) for this org.
  select array_agg(id) into v_test_ids
  from public.food_safety_cleaning_locations
  where organization_id = v_org_id
    and name ~* '^zz_';

  v_test_ids := coalesce(v_test_ids, array[]::uuid[]);
  v_test_count := array_length(v_test_ids, 1);
  v_test_count := coalesce(v_test_count, 0);

  raise notice 'Organization id: %', v_org_id;
  raise notice 'Washroom 1 location id: %', v_washroom1_id;
  raise notice 'Test location ids (%): %', v_test_count, v_test_ids;

  insert into food_safety_cleanup_summary values ('org', 'First Light Greenhouses inc', 1);
  insert into food_safety_cleanup_summary values ('washroom_1_location_id', v_washroom1_id::text, 1);
  insert into food_safety_cleanup_summary values ('test_location_ids', v_test_ids::text, v_test_count);

  select count(*) into v_washroom1_reports_before from public.food_safety_cleaning_reports where location_id = v_washroom1_id;
  select count(*) into v_washroom1_checklists_before from public.food_safety_cleaning_checklists where location_id = v_washroom1_id;
  select count(*) into v_test_reports_before from public.food_safety_cleaning_reports where location_id = any(v_test_ids);
  select count(*) into v_test_checklists_before from public.food_safety_cleaning_checklists where location_id = any(v_test_ids);

  -- Disable the immutability triggers for the duration of this transaction
  -- only. A rollback (any RAISE EXCEPTION above or below) undoes this too.
  alter table public.food_safety_cleaning_reports disable trigger food_safety_cleaning_reports_immutable;
  alter table public.food_safety_cleaning_report_items disable trigger food_safety_cleaning_report_items_immutable;

  -- --- Washroom 1: reports + report_items (cascade) + checklists + ---
  -- --- checklist_items (cascade). Location row and its tasks untouched. ---
  delete from public.food_safety_cleaning_reports where location_id = v_washroom1_id;
  get diagnostics v_deleted = row_count;
  insert into food_safety_cleanup_summary values ('washroom_1_reports_deleted', 'food_safety_cleaning_reports', v_deleted);

  delete from public.food_safety_cleaning_checklists where location_id = v_washroom1_id;
  get diagnostics v_deleted = row_count;
  insert into food_safety_cleanup_summary values ('washroom_1_checklists_deleted', 'food_safety_cleaning_checklists', v_deleted);

  -- --- Test locations: reports + report_items (cascade) + checklists + ---
  -- --- checklist_items (cascade), then the locations themselves (cascades ---
  -- --- to food_safety_cleaning_tasks via its own ON DELETE CASCADE FK). ---
  if v_test_count > 0 then
    delete from public.food_safety_cleaning_reports where location_id = any(v_test_ids);
    get diagnostics v_deleted = row_count;
    insert into food_safety_cleanup_summary values ('test_locations_reports_deleted', 'food_safety_cleaning_reports', v_deleted);

    delete from public.food_safety_cleaning_checklists where location_id = any(v_test_ids);
    get diagnostics v_deleted = row_count;
    insert into food_safety_cleanup_summary values ('test_locations_checklists_deleted', 'food_safety_cleaning_checklists', v_deleted);

    delete from public.food_safety_cleaning_locations where id = any(v_test_ids);
    get diagnostics v_deleted = row_count;
    insert into food_safety_cleanup_summary values ('test_locations_deleted', 'food_safety_cleaning_locations', v_deleted);
  else
    insert into food_safety_cleanup_summary values ('test_locations_deleted', 'none found', 0);
  end if;

  -- Re-enable the safeguard before commit.
  alter table public.food_safety_cleaning_report_items enable trigger food_safety_cleaning_report_items_immutable;
  alter table public.food_safety_cleaning_reports enable trigger food_safety_cleaning_reports_immutable;

  insert into food_safety_cleanup_summary values ('washroom_1_reports_before', 'pre-delete count', v_washroom1_reports_before);
  insert into food_safety_cleanup_summary values ('washroom_1_checklists_before', 'pre-delete count', v_washroom1_checklists_before);
  insert into food_safety_cleanup_summary values ('test_locations_reports_before', 'pre-delete count', v_test_reports_before);
  insert into food_safety_cleanup_summary values ('test_locations_checklists_before', 'pre-delete count', v_test_checklists_before);
end $$;

-- Prints the full before/after summary as a result set (visible in the
-- Supabase SQL editor's results grid, not just the log/notices panel).
select * from food_safety_cleanup_summary order by step;

commit;


-- =========================================================================
-- STEP 3 -- INTEGRITY VERIFICATION (read-only). Run after Step 2 commits.
-- Every query below should return 0 / no rows.
-- =========================================================================

-- Washroom 1 must show 0 reports now, and still exist with its tasks intact.
select
  l.id, l.name, l.is_active,
  (select count(*) from public.food_safety_cleaning_reports r where r.location_id = l.id) as report_count,
  (select count(*) from public.food_safety_cleaning_tasks t where t.location_id = l.id) as task_count
from public.food_safety_cleaning_locations l
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and lower(l.name) = 'washroom 1';
-- Expect: report_count = 0, task_count unchanged from before this script ran.

-- No ZZ_ test locations should remain for this org.
select l.id, l.name
from public.food_safety_cleaning_locations l
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and l.name ~* '^zz_';
-- Expect: no rows.

-- No orphaned report_items (report_id pointing nowhere).
select ri.id, ri.report_id
from public.food_safety_cleaning_report_items ri
left join public.food_safety_cleaning_reports r on r.id = ri.report_id
where r.id is null;
-- Expect: no rows.

-- No orphaned checklist_items (checklist_id pointing nowhere).
select ci.id, ci.checklist_id
from public.food_safety_cleaning_checklist_items ci
left join public.food_safety_cleaning_checklists c on c.id = ci.checklist_id
where c.id is null;
-- Expect: no rows.

-- No reports/tasks left dangling from the now-deleted test locations
-- (location_id is ON DELETE SET NULL on reports, so these would show up
-- with a null location_id rather than an FK violation -- there should be
-- none, since we deleted the test locations' reports explicitly first).
select id, location_name_snapshot, location_id
from public.food_safety_cleaning_reports
where location_id is null
  and organization_id = (select id from public.organizations where name = 'First Light Greenhouses inc');
-- Expect: no rows (unless this org had pre-existing, unrelated reports for
-- an already-deleted legitimate location -- review any hits by name/date
-- before assuming they're related to this cleanup).

-- Both immutability triggers must be back on.
select tgname, tgenabled
from pg_trigger
where tgname in ('food_safety_cleaning_reports_immutable', 'food_safety_cleaning_report_items_immutable');
-- Expect: two rows, tgenabled = 'O' (origin -- i.e. enabled) for both.
