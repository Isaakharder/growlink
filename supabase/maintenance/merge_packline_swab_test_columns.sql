-- One-time production data cleanup, requested 2026-07-28 for First Light
-- Greenhouses inc. Executed successfully against production on 2026-07-28
-- (Step 2 committed; Step 3's verification queries all returned the
-- expected results -- see the bottom of this file). Scoped to exactly one
-- location, "Cleaning Packline / Packing Area", and touches nothing else.
--
-- What it did: merged two obsolete historical task_name_snapshot labels --
-- "Rotate through swab tests locations 1-4, 5-8, 9-12" and "Rotate through
-- swab tests locations 1-3, 4-6, 7-9" -- into the one retained/current
-- label, "Rotate through swab tests locations 1 2 or 3", so the Reports
-- page shows one column instead of three for what has always been one
-- task. It changed only task_name_snapshot text on two rows (one
-- food_safety_cleaning_report_items row, plus the checklist_items rows
-- carrying the same obsolete wording -- see "Scope, precisely" below for
-- exact ids). It did NOT change any report count, response_value,
-- timestamp, employee attribution, checklist attempt, or the live retained
-- task definition (food_safety_cleaning_tasks id
-- 48288009-f151-4165-ad02-260f5ad20099) -- all verified unchanged in Step 3.
--
-- The "Rotate through swab tests locations 1 2 or 3" short-text task at
-- "Cleaning Packline / Packing Area" was renamed more than once over time.
-- Because Food Safety report columns are identified purely by
-- food_safety_cleaning_report_items.task_name_snapshot text (that table has
-- no task_id column at all -- confirmed by reading its schema, migration
-- 0088), each rename left old wording baked into historical rows, so the
-- Reports page showed three separate columns for what is really one task:
--
--   1. Rotate through swab tests locations 1 2 or 3            <- keep, current
--   2. Rotate through swab tests locations 1-4, 5-8, 9-12       <- obsolete
--   3. Rotate through swab tests locations 1-3, 4-6, 7-9        <- obsolete
--
-- Investigation (read-only, against live data): this location has exactly
-- one live task row today (id 48288009-f151-4165-ad02-260f5ad20099, the
-- retained name) -- neither obsolete name exists as a live task row
-- anymore; a prior desktop edit already deleted them. Across all 18 reports
-- at this location, exactly one report_item anywhere carries an obsolete
-- name: Lemuel Langaoen's 2026-07-25 1:36 PM (America/Toronto) report,
-- value "3", under "...1-3, 4-6, 7-9". That report has no existing
-- retained-name item, so this is a pure identity rename, not a merge of two
-- values. The other obsolete name ("...1-4, 5-8, 9-12") has zero
-- report_items anywhere -- its only report was already removed via the
-- report-deletion feature -- but it still labels one checklist_item on the
-- CURRENT week's (2026-W31) already-completed checklist, which would still
-- render with the old wording on the mobile checklist's completed view, so
-- that one row is corrected too even though checklist_items were not
-- explicitly named as in-scope by the request.
--
-- Scope, precisely: exactly two rows change.
--   - food_safety_cleaning_report_items id 6a15e357-7d2a-4232-9b19-99bff0721126
--     (report fb0751aa-e30b-4819-aa62-3f234cf50320): task_name_snapshot only.
--   - food_safety_cleaning_checklist_items id c60902e3-15c3-4d0b-a49e-f4272b4d345e
--     (checklist 228a374e-b931-426f-a637-973c971718c0): task_name_snapshot only.
-- response_value, sort_order, checked_at/by_*, completed_at, employee
-- attribution, report id, checklist id, attempt number, and every other
-- column are left byte-for-byte unchanged. No row is created or deleted; no
-- report is recreated; no checklist attempt is added or removed. The
-- retained task row (48288009-...) is never touched.
--
-- IMPORTANT -- like the two earlier Food Safety data-correction scripts in
-- this directory, this overrides the deliberate immutability trigger on
-- food_safety_cleaning_reports and food_safety_cleaning_report_items
-- (migrations 0088/0090), which unconditionally rejects UPDATE/DELETE so
-- completed reports can't be edited or lost by accident. It's disabled only
-- for the duration of this one transaction and re-enabled before commit;
-- any error rolls back the disable too, so the safeguard can never be left
-- off. food_safety_cleaning_checklists/_checklist_items carry no such
-- trigger, so the checklist_item correction needs no special handling.
--
-- Re-running: harmless. Since this already ran successfully, every guard
-- below will find its expected starting state gone and abort cleanly with a
-- clear message (e.g. "No report_item referencing an obsolete swab-test
-- task name was found at this location -- aborting (nothing to migrate)."),
-- roll back, and change nothing -- verified by actually running it twice
-- against a seeded replica before running it against production.


-- =========================================================================
-- STEP 1 -- PREVIEW (read-only). Run this first and confirm the rows
-- listed below are exactly what you expect before running Step 2.
-- =========================================================================

-- Org and location being targeted.
select o.id as organization_id, o.name as organization_name, l.id as location_id, l.name as location_name, l.area
from public.food_safety_cleaning_locations l
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and l.name = 'Cleaning Packline / Packing Area';

-- The retained task -- confirm it is the only live task with any of the
-- three names, and that it is left out of every UPDATE below.
select id, name, response_type, sort_order
from public.food_safety_cleaning_tasks
where location_id = (
  select l.id from public.food_safety_cleaning_locations l
  join public.organizations o on o.id = l.organization_id
  where o.name = 'First Light Greenhouses inc' and l.name = 'Cleaning Packline / Packing Area'
)
and name in (
  'Rotate through swab tests locations 1 2 or 3',
  'Rotate through swab tests locations 1-4, 5-8, 9-12',
  'Rotate through swab tests locations 1-3, 4-6, 7-9'
);
-- Expect: exactly one row, the retained name.

-- The exact report_item that will be renamed, and confirmation its report
-- has no pre-existing retained-name item to conflict with.
select
  ri.id as report_item_id, ri.report_id, ri.task_name_snapshot, ri.response_value,
  r.completed_at, r.completed_by_name, r.completed_by_initials,
  (select count(*) from public.food_safety_cleaning_report_items ri2
   where ri2.report_id = ri.report_id and ri2.task_name_snapshot = 'Rotate through swab tests locations 1 2 or 3') as existing_retained_items_on_same_report
from public.food_safety_cleaning_report_items ri
join public.food_safety_cleaning_reports r on r.id = ri.report_id
where r.location_id = (
  select l.id from public.food_safety_cleaning_locations l
  join public.organizations o on o.id = l.organization_id
  where o.name = 'First Light Greenhouses inc' and l.name = 'Cleaning Packline / Packing Area'
)
and ri.task_name_snapshot in (
  'Rotate through swab tests locations 1-4, 5-8, 9-12',
  'Rotate through swab tests locations 1-3, 4-6, 7-9'
);
-- Expect: exactly one row (Lemuel Langaoen, 2026-07-25 17:36 UTC, value "3",
-- existing_retained_items_on_same_report = 0).

-- Every checklist_item that will be renamed -- one per obsolete name that
-- still labels a historical checklist snapshot (checklist_items carry no
-- immutability trigger and are never displayed as report "columns", so
-- there is no duplicate-value merge concern here the way there is for
-- report_items -- each is an independent point-in-time record on its own
-- checklist).
select
  ci.id as checklist_item_id, ci.checklist_id, ci.task_id, ci.task_name_snapshot, ci.response_value,
  c.period_type, c.period_key, c.attempt_number, c.status
from public.food_safety_cleaning_checklist_items ci
join public.food_safety_cleaning_checklists c on c.id = ci.checklist_id
where c.location_id = (
  select l.id from public.food_safety_cleaning_locations l
  join public.organizations o on o.id = l.organization_id
  where o.name = 'First Light Greenhouses inc' and l.name = 'Cleaning Packline / Packing Area'
)
and ci.task_name_snapshot in (
  'Rotate through swab tests locations 1-4, 5-8, 9-12',
  'Rotate through swab tests locations 1-3, 4-6, 7-9'
);
-- Expect: up to two rows (at most one per obsolete name) -- as investigated,
-- period 2026-W30 (the checklist that generated Lemuel's report) and period
-- 2026-W31 (the current week's already-completed, report-deleted checklist).


-- =========================================================================
-- STEP 2 -- CORRECTION (destructive). Only run after reviewing Step 1.
-- =========================================================================

begin;

create temporary table swab_column_merge_summary (
  step text,
  detail text,
  row_count integer
) on commit preserve rows;

do $$
declare
  v_org_id uuid;
  v_location_id uuid;
  v_retained_task_id uuid;
  v_report_item_id uuid;
  v_report_id uuid;
  v_report_item_value text;
  v_existing_retained_count integer;
  v_checklist_items_matched integer;
  v_updated integer;
begin
  -- Resolve the organization by name; hard-stop if it's not exactly one row.
  select id into v_org_id
  from public.organizations
  where name = 'First Light Greenhouses inc';

  if v_org_id is null then
    raise exception 'Organization "First Light Greenhouses inc" not found -- aborting.';
  end if;

  if (select count(*) from public.organizations where name = 'First Light Greenhouses inc') > 1 then
    raise exception 'More than one organization named "First Light Greenhouses inc" -- aborting, resolve ambiguity manually.';
  end if;

  -- Resolve the location by name within this org; hard-stop unless exactly
  -- one match.
  select id into v_location_id
  from public.food_safety_cleaning_locations
  where organization_id = v_org_id
    and name = 'Cleaning Packline / Packing Area';

  if v_location_id is null then
    raise exception 'Location "Cleaning Packline / Packing Area" not found -- aborting.';
  end if;

  if (select count(*) from public.food_safety_cleaning_locations
      where organization_id = v_org_id and name = 'Cleaning Packline / Packing Area') > 1 then
    raise exception 'More than one "Cleaning Packline / Packing Area" location found -- aborting.';
  end if;

  -- Resolve (and protect) the retained task -- hard-stop unless exactly one
  -- live task has this exact name at this location.
  select id into v_retained_task_id
  from public.food_safety_cleaning_tasks
  where location_id = v_location_id
    and name = 'Rotate through swab tests locations 1 2 or 3';

  if v_retained_task_id is null then
    raise exception 'Retained task "Rotate through swab tests locations 1 2 or 3" not found at this location -- aborting.';
  end if;

  if (select count(*) from public.food_safety_cleaning_tasks
      where location_id = v_location_id and name = 'Rotate through swab tests locations 1 2 or 3') > 1 then
    raise exception 'More than one live task named "Rotate through swab tests locations 1 2 or 3" -- aborting, resolve ambiguity manually.';
  end if;

  raise notice 'Organization id: %', v_org_id;
  raise notice 'Location id: %', v_location_id;
  raise notice 'Retained task id: %', v_retained_task_id;

  insert into swab_column_merge_summary values ('organization_id', v_org_id::text, 1);
  insert into swab_column_merge_summary values ('location_id', v_location_id::text, 1);
  insert into swab_column_merge_summary values ('retained_task_id', v_retained_task_id::text, 1);

  -- Resolve the single obsolete report_item; hard-stop unless exactly one
  -- match exists for this location.
  select ri.id, ri.report_id, ri.response_value
    into v_report_item_id, v_report_id, v_report_item_value
  from public.food_safety_cleaning_report_items ri
  join public.food_safety_cleaning_reports r on r.id = ri.report_id
  where r.location_id = v_location_id
    and ri.task_name_snapshot in (
      'Rotate through swab tests locations 1-4, 5-8, 9-12',
      'Rotate through swab tests locations 1-3, 4-6, 7-9'
    );

  if v_report_item_id is null then
    raise exception 'No report_item referencing an obsolete swab-test task name was found at this location -- aborting (nothing to migrate).';
  end if;

  if (select count(*) from public.food_safety_cleaning_report_items ri
      join public.food_safety_cleaning_reports r on r.id = ri.report_id
      where r.location_id = v_location_id
        and ri.task_name_snapshot in (
          'Rotate through swab tests locations 1-4, 5-8, 9-12',
          'Rotate through swab tests locations 1-3, 4-6, 7-9'
        )) > 1 then
    raise exception 'More than one report_item references an obsolete swab-test task name at this location -- aborting, this script only expects one and needs review.';
  end if;

  insert into swab_column_merge_summary values ('report_item_id', v_report_item_id::text, 1);
  insert into swab_column_merge_summary values ('report_id', v_report_id::text, 1);

  -- Duplicate-value safety: does the retained column already have a value
  -- on this same report?
  select count(*) into v_existing_retained_count
  from public.food_safety_cleaning_report_items
  where report_id = v_report_id
    and task_name_snapshot = 'Rotate through swab tests locations 1 2 or 3';

  if v_existing_retained_count > 1 then
    raise exception 'Report % already has more than one retained-column item -- aborting, needs manual review.', v_report_id;
  end if;

  -- Disable the immutability triggers for the duration of this transaction
  -- only. A rollback (any RAISE EXCEPTION above or below) undoes this too.
  alter table public.food_safety_cleaning_reports disable trigger food_safety_cleaning_reports_immutable;
  alter table public.food_safety_cleaning_report_items disable trigger food_safety_cleaning_report_items_immutable;

  if v_existing_retained_count = 0 then
    -- No existing retained value on this report: pure identity rename,
    -- moves the value "3" onto the retained column. response_value,
    -- sort_order, checked_at/by_*, and every other column untouched.
    update public.food_safety_cleaning_report_items
    set task_name_snapshot = 'Rotate through swab tests locations 1 2 or 3'
    where id = v_report_item_id;
    get diagnostics v_updated = row_count;
    insert into swab_column_merge_summary values ('report_item_renamed', v_report_item_value, v_updated);
  else
    -- A retained-column item already exists on this report: compare values
    -- rather than blindly overwrite.
    declare
      v_existing_value text;
    begin
      select response_value into v_existing_value
      from public.food_safety_cleaning_report_items
      where report_id = v_report_id
        and task_name_snapshot = 'Rotate through swab tests locations 1 2 or 3';

      if v_existing_value is null or v_existing_value = '' then
        -- Retained column is empty: move the obsolete value onto it, then
        -- remove the now-redundant obsolete row.
        update public.food_safety_cleaning_report_items
        set response_value = v_report_item_value
        where report_id = v_report_id
          and task_name_snapshot = 'Rotate through swab tests locations 1 2 or 3';
        delete from public.food_safety_cleaning_report_items where id = v_report_item_id;
        get diagnostics v_updated = row_count;
        insert into swab_column_merge_summary values ('report_item_value_moved_and_obsolete_deleted', v_report_item_value, v_updated);
      elsif v_existing_value = v_report_item_value then
        -- Same value already present: the obsolete row is a pure duplicate.
        delete from public.food_safety_cleaning_report_items where id = v_report_item_id;
        get diagnostics v_updated = row_count;
        insert into swab_column_merge_summary values ('obsolete_duplicate_deleted', v_report_item_value, v_updated);
      else
        raise exception 'Report % already has a DIFFERENT value (%) under the retained column than the obsolete row (%) -- aborting, needs manual review.',
          v_report_id, v_existing_value, v_report_item_value;
      end if;
    end;
  end if;

  -- Re-enable the safeguard before touching anything else.
  alter table public.food_safety_cleaning_report_items enable trigger food_safety_cleaning_report_items_immutable;
  alter table public.food_safety_cleaning_reports enable trigger food_safety_cleaning_reports_immutable;

  -- checklist_items carries no immutability trigger, and (unlike
  -- report_items) checklist_items are never displayed as report "columns"
  -- or merged with anything else -- each is an independent point-in-time
  -- record on its own checklist, so a plain bulk rename is safe with no
  -- per-row duplicate-value resolution needed. Investigated (read-only,
  -- before writing this script) to be exactly two rows: the checklist that
  -- generated Lemuel's report (period 2026-W30) and the current week's
  -- already-completed, report-deleted checklist (2026-W31) -- both would
  -- otherwise still show obsolete wording historically / on the mobile
  -- checklist's completed view. A sanity cap well above that guards against
  -- silently mass-updating if this location's data turns out to differ from
  -- what was actually investigated.
  select count(*) into v_checklist_items_matched
  from public.food_safety_cleaning_checklist_items ci
  join public.food_safety_cleaning_checklists c on c.id = ci.checklist_id
  where c.location_id = v_location_id
    and ci.task_name_snapshot in (
      'Rotate through swab tests locations 1-4, 5-8, 9-12',
      'Rotate through swab tests locations 1-3, 4-6, 7-9'
    );

  if v_checklist_items_matched > 5 then
    raise exception 'Unexpectedly many checklist_items (%) reference an obsolete swab-test task name at this location -- aborting, needs manual review.', v_checklist_items_matched;
  end if;

  update public.food_safety_cleaning_checklist_items ci
  set task_name_snapshot = 'Rotate through swab tests locations 1 2 or 3'
  from public.food_safety_cleaning_checklists c
  where c.id = ci.checklist_id
    and c.location_id = v_location_id
    and ci.task_name_snapshot in (
      'Rotate through swab tests locations 1-4, 5-8, 9-12',
      'Rotate through swab tests locations 1-3, 4-6, 7-9'
    );
  get diagnostics v_updated = row_count;
  insert into swab_column_merge_summary values ('checklist_items_renamed', v_checklist_items_matched::text || ' matched', v_updated);
end $$;

-- Prints the full summary as a result set (visible in the Supabase SQL
-- editor's results grid, not just the log/notices panel).
select * from swab_column_merge_summary order by step;

commit;


-- =========================================================================
-- STEP 3 -- VERIFICATION (read-only). Run after Step 2 commits.
-- =========================================================================

-- No report_item or checklist_item at this location should reference either
-- obsolete name anymore.
select 'report_items' as table_name, ri.id, ri.task_name_snapshot
from public.food_safety_cleaning_report_items ri
join public.food_safety_cleaning_reports r on r.id = ri.report_id
where r.location_id = (
  select l.id from public.food_safety_cleaning_locations l
  join public.organizations o on o.id = l.organization_id
  where o.name = 'First Light Greenhouses inc' and l.name = 'Cleaning Packline / Packing Area'
)
and ri.task_name_snapshot in ('Rotate through swab tests locations 1-4, 5-8, 9-12', 'Rotate through swab tests locations 1-3, 4-6, 7-9')
union all
select 'checklist_items' as table_name, ci.id, ci.task_name_snapshot
from public.food_safety_cleaning_checklist_items ci
join public.food_safety_cleaning_checklists c on c.id = ci.checklist_id
where c.location_id = (
  select l.id from public.food_safety_cleaning_locations l
  join public.organizations o on o.id = l.organization_id
  where o.name = 'First Light Greenhouses inc' and l.name = 'Cleaning Packline / Packing Area'
)
and ci.task_name_snapshot in ('Rotate through swab tests locations 1-4, 5-8, 9-12', 'Rotate through swab tests locations 1-3, 4-6, 7-9');
-- Expect: no rows.

-- Lemuel Langaoen's report now shows the value under the retained column.
select r.id as report_id, r.completed_at, r.completed_by_name, r.completed_by_initials,
       ri.task_name_snapshot, ri.response_value
from public.food_safety_cleaning_reports r
join public.food_safety_cleaning_report_items ri on ri.report_id = r.id
where r.id = 'fb0751aa-e30b-4819-aa62-3f234cf50320'
  and ri.task_name_snapshot = 'Rotate through swab tests locations 1 2 or 3';
-- Expect: one row, response_value = '3'.

-- Report count for this location must be unchanged (18).
select count(*) as report_count
from public.food_safety_cleaning_reports
where location_id = (
  select l.id from public.food_safety_cleaning_locations l
  join public.organizations o on o.id = l.organization_id
  where o.name = 'First Light Greenhouses inc' and l.name = 'Cleaning Packline / Packing Area'
);
-- Expect: 18.

-- The retained task definition itself must be completely unchanged.
select id, name, response_type, sort_order
from public.food_safety_cleaning_tasks
where id = (
  select id from public.food_safety_cleaning_tasks
  where location_id = (
    select l.id from public.food_safety_cleaning_locations l
    join public.organizations o on o.id = l.organization_id
    where o.name = 'First Light Greenhouses inc' and l.name = 'Cleaning Packline / Packing Area'
  )
  and name = 'Rotate through swab tests locations 1 2 or 3'
);
-- Expect: exactly one row, same id/name/response_type/sort_order as Step 1's preview.

-- Both immutability triggers must be back on.
select tgname, tgenabled
from pg_trigger
where tgname in ('food_safety_cleaning_reports_immutable', 'food_safety_cleaning_report_items_immutable');
-- Expect: two rows, tgenabled = 'O' (origin -- i.e. enabled) for both.
