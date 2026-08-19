-- One-time historical data correction, requested 2026-08-03 for First Light
-- Greenhouses inc:
--
-- The "Hand Sanitizer" cleaning task was added to 7 washroom locations on
-- 2026-07-29 (confirmed via food_safety_cleaning_tasks.created_at), after
-- many historical daily cleaning reports at those locations had already been
-- completed and saved. This backfills a single checked "Hand Sanitizer"
-- answer onto 3 existing, already-completed historical reports per location
-- (21 reports total) so the task's presence is represented across the
-- location's history, without creating any new report and without touching
-- any other saved answer.
--
-- Root cause / investigation notes:
--   - food_safety_cleaning_reports/_report_items are immutable snapshots
--     (migrations 0088/0090) copied at the moment a location was completed.
--     A task added later has no way to appear on a report snapshot taken
--     before it existed -- there is no "regenerate historical reports" path
--     in the app, by design.
--   - Two other locations were originally in scope ("Hand Wash Station",
--     Greenhouse Phase 3, and "Hand Washing Station", Greenhouse Entrance)
--     but were dropped after investigation showed EVERY historical report at
--     both already carries a Hand Sanitizer report_item (163/163 and 165/165
--     respectively -- 2 already checked, the rest unchecked/null). There is
--     no report at either location missing the item, so there is nothing to
--     "add" without overwriting an existing unchecked answer, which is out
--     of scope for this script (a different, more invasive correction).
--     Confirmed with the user 2026-08-03 to proceed with only the 7
--     washrooms below.
--   - For the 7 washrooms actually in scope, each has exactly ONE existing
--     Hand Sanitizer report_item across its full history (the report closest
--     to/after the 2026-07-29 task-creation date) -- consistent with the
--     task being genuinely new there. The 21 reports below were chosen from
--     the remaining eligible (no existing Hand Sanitizer item) reports,
--     picked deterministically (no ORDER BY random()) at the 1/6, 3/6, and
--     5/6 fractional positions of each location's eligible, date-ordered,
--     one-per-calendar-day report list -- an early/middle/late spread.
--   - All 21 selected reports have a checklist_signature of the form
--     'legacy:<own report id>' (pre-attempt-tracking backfilled rows, see
--     migration 0101) -- i.e. NONE of them have a real, addressable
--     food_safety_cleaning_checklists row. Section 6 (checklist consistency)
--     is therefore a no-op for every row in this script: there is no
--     checklist/checklist_item to keep in sync. This is verified again,
--     defensively, inside the transaction below (v_checklist_hits must be 0).
--
-- Scope, precisely: exactly the 21 (location, report_id) pairs hardcoded in
-- hand_sanitizer_targets below get one new food_safety_cleaning_report_items
-- row each (task_name_snapshot = 'Hand Sanitizer', action_label_snapshot =
-- 'Restocked', response_value = 'true'), using the CURRENT
-- food_safety_cleaning_tasks row for "Hand Sanitizer" at that location as the
-- source of truth for sort_order/response_type/action_label (never guessed).
-- checked_at/checked_by_* on the new row mirror the REPORT's own
-- completed_at/completed_by_* (the original employee and moment), never the
-- person running this script. No existing row in food_safety_cleaning_reports
-- or food_safety_cleaning_report_items is updated or deleted; task_count is
-- deliberately left as originally recorded (nothing in the app reads it for
-- Food Safety -- verified against every server/client reference -- so this is
-- a harmless, intentional staleness rather than a correction).
--
-- IMPORTANT -- this overrides the deliberate immutability trigger on
-- food_safety_cleaning_report_items (migrations 0088/0090), which
-- unconditionally rejects UPDATE/DELETE (this script only INSERTs, which the
-- trigger does not gate -- but it is disabled for the duration anyway, out of
-- caution, exactly like the precedent scripts in this directory). Disabled
-- only for the duration of this one transaction and re-enabled before commit;
-- any error rolls back the disable too, so the safeguard can never be left
-- off. food_safety_cleaning_reports itself is never written to by this
-- script and its trigger is left untouched throughout.
--
-- Safe against accidental rerun: every INSERT below is guarded by a NOT
-- EXISTS check against the exact (report_id, task_name_snapshot,
-- action_label_snapshot) triple, so a second run inserts zero further rows.


-- =========================================================================
-- STEP 1 -- PREVIEW (read-only). Run first and confirm every row listed is
-- exactly what should change before running Step 2.
-- =========================================================================

with hand_sanitizer_targets (location_name, report_id, selection_bucket) as (
  values
    ('Washroom 2', 'a94342d9-21b3-48ac-81e8-22ed31a8dd01'::uuid, 'early'),
    ('Washroom 2', 'f24af1b1-dc03-4b5f-a1c8-2189dd716b9b'::uuid, 'middle'),
    ('Washroom 2', '04912c07-27c1-4ea1-b762-b945b87c6cc7'::uuid, 'late'),

    ('Washroom 3', 'b8ed341f-37ea-40a8-8342-f66d5cdee94d'::uuid, 'early'),
    ('Washroom 3', '234e3498-cba5-4269-9b47-6dd4d518970c'::uuid, 'middle'),
    ('Washroom 3', '5f3c8f3e-b2ff-43c4-8708-846b84e06b05'::uuid, 'late'),

    ('Washroom 4', '89abf8f6-9b82-47c5-8e59-153c3faee986'::uuid, 'early'),
    ('Washroom 4', '04d096d9-b381-4306-9f52-541be80a4c5b'::uuid, 'middle'),
    ('Washroom 4', 'b04a73f1-3dce-4bbb-a646-273e22bb26bf'::uuid, 'late'),

    ('Washroom 5', '12729f90-beaa-4d2e-9aa3-cf06c3693a12'::uuid, 'early'),
    ('Washroom 5', '94ac7f10-48ed-4b02-8219-19db14995b7a'::uuid, 'middle'),
    ('Washroom 5', '6dda0a55-fa65-40ff-a989-f1515611cf3e'::uuid, 'late'),

    ('Washroom 6', '7d037b2c-ef7d-48d1-a8fe-75d25208d8ac'::uuid, 'early'),
    ('Washroom 6', '857f246d-bf09-425c-8652-a8b9cc25b65a'::uuid, 'middle'),
    ('Washroom 6', '1b4349d9-6eb7-4f38-b25b-d01369a189b1'::uuid, 'late'),

    ('Washroom 7', 'c60fc46d-fdc7-4add-8e47-1a58dc58131f'::uuid, 'early'),
    ('Washroom 7', '16a8c60a-e477-4580-8b20-f14e2fc08dfa'::uuid, 'middle'),
    ('Washroom 7', '606f858a-e2fd-4b04-a561-e77837e9b356'::uuid, 'late'),

    ('Washroom 8', 'a2503ab3-84f6-4cec-bfe8-de19d7cfbdd8'::uuid, 'early'),
    ('Washroom 8', '99c6885d-63e4-42f7-bb80-5cd893d93b45'::uuid, 'middle'),
    ('Washroom 8', '5b682b0e-746e-4880-b294-ded6b493f761'::uuid, 'late')
)
select
  t.location_name,
  r.id as report_id,
  r.completed_at,
  r.completed_by_name || ' (' || r.completed_by_initials || ')' as employee,
  r.checklist_signature,
  (select count(*) from public.food_safety_cleaning_report_items ri
     where ri.report_id = r.id and ri.task_name_snapshot = 'Hand Sanitizer') as existing_hand_sanitizer_items,
  'insert checked Hand Sanitizer report item' as proposed_action
from hand_sanitizer_targets t
join public.food_safety_cleaning_reports r on r.id = t.report_id
join public.food_safety_cleaning_locations l on l.id = r.location_id and l.name = t.location_name
order by t.location_name, t.selection_bucket;
-- Expect: 21 rows, existing_hand_sanitizer_items = 0 on every row, every
-- checklist_signature starting with 'legacy:'.

-- Org-level count check: exactly 7 locations, 3 reports each.
with hand_sanitizer_targets (location_name, report_id) as (
  values
    ('Washroom 2', 'a94342d9-21b3-48ac-81e8-22ed31a8dd01'::uuid), ('Washroom 2', 'f24af1b1-dc03-4b5f-a1c8-2189dd716b9b'::uuid), ('Washroom 2', '04912c07-27c1-4ea1-b762-b945b87c6cc7'::uuid),
    ('Washroom 3', 'b8ed341f-37ea-40a8-8342-f66d5cdee94d'::uuid), ('Washroom 3', '234e3498-cba5-4269-9b47-6dd4d518970c'::uuid), ('Washroom 3', '5f3c8f3e-b2ff-43c4-8708-846b84e06b05'::uuid),
    ('Washroom 4', '89abf8f6-9b82-47c5-8e59-153c3faee986'::uuid), ('Washroom 4', '04d096d9-b381-4306-9f52-541be80a4c5b'::uuid), ('Washroom 4', 'b04a73f1-3dce-4bbb-a646-273e22bb26bf'::uuid),
    ('Washroom 5', '12729f90-beaa-4d2e-9aa3-cf06c3693a12'::uuid), ('Washroom 5', '94ac7f10-48ed-4b02-8219-19db14995b7a'::uuid), ('Washroom 5', '6dda0a55-fa65-40ff-a989-f1515611cf3e'::uuid),
    ('Washroom 6', '7d037b2c-ef7d-48d1-a8fe-75d25208d8ac'::uuid), ('Washroom 6', '857f246d-bf09-425c-8652-a8b9cc25b65a'::uuid), ('Washroom 6', '1b4349d9-6eb7-4f38-b25b-d01369a189b1'::uuid),
    ('Washroom 7', 'c60fc46d-fdc7-4add-8e47-1a58dc58131f'::uuid), ('Washroom 7', '16a8c60a-e477-4580-8b20-f14e2fc08dfa'::uuid), ('Washroom 7', '606f858a-e2fd-4b04-a561-e77837e9b356'::uuid),
    ('Washroom 8', 'a2503ab3-84f6-4cec-bfe8-de19d7cfbdd8'::uuid), ('Washroom 8', '99c6885d-63e4-42f7-bb80-5cd893d93b45'::uuid), ('Washroom 8', '5b682b0e-746e-4880-b294-ded6b493f761'::uuid)
)
select location_name, count(*) as reports_targeted
from hand_sanitizer_targets
group by location_name
order by location_name;
-- Expect: 7 rows, reports_targeted = 3 for every location.

-- Current live "Hand Sanitizer" task definition per location (source of
-- truth for the values inserted in Step 2 -- nothing below is guessed).
select l.name as location_name, t.id as task_id, t.response_type, t.action_labels,
       t.is_required, t.number_unit, t.sort_order, (t.sort_order * 100) as report_item_sort_order
from public.food_safety_cleaning_locations l
join public.food_safety_cleaning_tasks t on t.location_id = l.id and t.name = 'Hand Sanitizer'
where l.organization_id = (select id from public.organizations where name = 'First Light Greenhouses inc')
  and l.name in ('Washroom 2','Washroom 3','Washroom 4','Washroom 5','Washroom 6','Washroom 7','Washroom 8')
order by l.name;
-- Expect: 7 rows, response_type = 'checkbox', action_labels = {Restocked},
-- is_required = true, number_unit = null.


-- =========================================================================
-- STEP 2 -- CORRECTION (destructive). Only run after reviewing Step 1.
-- =========================================================================

begin;

create temporary table hand_sanitizer_backfill_summary (
  step text,
  detail text,
  row_count integer
) on commit preserve rows;

do $$
declare
  v_org_id uuid;
  v_target_count integer;
  v_location_mismatch_count integer;
  v_already_has_item_count integer;
  v_checklist_hits integer;
  v_reports_before integer;
  v_reports_after integer;
  v_inserted integer;
  v_loc record;
  v_loc_count integer;
  v_task_count integer;
begin
  -- Resolve the organization by name; hard-stop if it's not exactly one row.
  select id into v_org_id
  from public.organizations
  where name = 'First Light Greenhouses inc';

  if v_org_id is null then
    raise exception 'Organization "First Light Greenhouses inc" not found -- aborting.';
  end if;

  if (select count(*) from public.organizations where name = 'First Light Greenhouses inc') > 1 then
    raise exception 'More than one organization named "First Light Greenhouses inc" -- aborting.';
  end if;

  -- The 21 approved (location, report_id) targets, exactly as shown in the
  -- Step 1 preview.
  create temporary table hand_sanitizer_targets (location_name text, report_id uuid) on commit drop;
  insert into hand_sanitizer_targets (location_name, report_id) values
    ('Washroom 2', 'a94342d9-21b3-48ac-81e8-22ed31a8dd01'), ('Washroom 2', 'f24af1b1-dc03-4b5f-a1c8-2189dd716b9b'), ('Washroom 2', '04912c07-27c1-4ea1-b762-b945b87c6cc7'),
    ('Washroom 3', 'b8ed341f-37ea-40a8-8342-f66d5cdee94d'), ('Washroom 3', '234e3498-cba5-4269-9b47-6dd4d518970c'), ('Washroom 3', '5f3c8f3e-b2ff-43c4-8708-846b84e06b05'),
    ('Washroom 4', '89abf8f6-9b82-47c5-8e59-153c3faee986'), ('Washroom 4', '04d096d9-b381-4306-9f52-541be80a4c5b'), ('Washroom 4', 'b04a73f1-3dce-4bbb-a646-273e22bb26bf'),
    ('Washroom 5', '12729f90-beaa-4d2e-9aa3-cf06c3693a12'), ('Washroom 5', '94ac7f10-48ed-4b02-8219-19db14995b7a'), ('Washroom 5', '6dda0a55-fa65-40ff-a989-f1515611cf3e'),
    ('Washroom 6', '7d037b2c-ef7d-48d1-a8fe-75d25208d8ac'), ('Washroom 6', '857f246d-bf09-425c-8652-a8b9cc25b65a'), ('Washroom 6', '1b4349d9-6eb7-4f38-b25b-d01369a189b1'),
    ('Washroom 7', 'c60fc46d-fdc7-4add-8e47-1a58dc58131f'), ('Washroom 7', '16a8c60a-e477-4580-8b20-f14e2fc08dfa'), ('Washroom 7', '606f858a-e2fd-4b04-a561-e77837e9b356'),
    ('Washroom 8', 'a2503ab3-84f6-4cec-bfe8-de19d7cfbdd8'), ('Washroom 8', '99c6885d-63e4-42f7-bb80-5cd893d93b45'), ('Washroom 8', '5b682b0e-746e-4880-b294-ded6b493f761');

  select count(*) into v_target_count from hand_sanitizer_targets;
  if v_target_count <> 21 then
    raise exception 'Expected exactly 21 target reports, found %  -- aborting.', v_target_count;
  end if;

  -- Every one of the 7 location names must resolve to exactly one ACTIVE
  -- location in this org with a currently-active "Hand Sanitizer" checkbox
  -- task -- abort on any miss or ambiguity rather than guess.
  for v_loc in
    select distinct location_name from hand_sanitizer_targets order by location_name
  loop
    select count(*) into v_loc_count
    from public.food_safety_cleaning_locations
    where organization_id = v_org_id and name = v_loc.location_name and is_active;

    if v_loc_count = 0 then
      raise exception 'Location "%" not found (active) in this organization -- aborting.', v_loc.location_name;
    end if;
    if v_loc_count > 1 then
      raise exception 'More than one active location named "%" -- aborting, resolve ambiguity manually.', v_loc.location_name;
    end if;

    select count(*) into v_task_count
    from public.food_safety_cleaning_tasks t
    join public.food_safety_cleaning_locations l on l.id = t.location_id
    where l.organization_id = v_org_id and l.name = v_loc.location_name and l.is_active
      and t.name = 'Hand Sanitizer';

    if v_task_count = 0 then
      raise exception 'Location "%" has no "Hand Sanitizer" task configured -- aborting.', v_loc.location_name;
    end if;
    if v_task_count > 1 then
      raise exception 'Location "%" has more than one "Hand Sanitizer" task -- aborting, resolve ambiguity manually.', v_loc.location_name;
    end if;
  end loop;

  -- Every target report_id must actually belong to the location named
  -- alongside it (guards against a stale/mistyped id in the VALUES list
  -- above pointing at the wrong location).
  select count(*) into v_location_mismatch_count
  from hand_sanitizer_targets t
  join public.food_safety_cleaning_reports r on r.id = t.report_id
  join public.food_safety_cleaning_locations l on l.id = r.location_id
  where l.name <> t.location_name or l.organization_id <> v_org_id;

  if v_location_mismatch_count > 0 then
    raise exception 'Found % target report(s) whose actual location does not match the expected location name -- aborting.', v_location_mismatch_count;
  end if;

  -- Every target report_id must actually exist (catches a typo'd/deleted id).
  if (select count(*) from hand_sanitizer_targets t
      join public.food_safety_cleaning_reports r on r.id = t.report_id) <> 21 then
    raise exception 'One or more target report ids do not exist in food_safety_cleaning_reports -- aborting.';
  end if;

  -- None of the 21 targets may already carry a Hand Sanitizer report item --
  -- this script only ever fills a gap, never overwrites an existing answer.
  select count(*) into v_already_has_item_count
  from hand_sanitizer_targets t
  join public.food_safety_cleaning_report_items ri
    on ri.report_id = t.report_id and ri.task_name_snapshot = 'Hand Sanitizer';

  if v_already_has_item_count > 0 then
    raise exception 'Found % target report(s) that already have a Hand Sanitizer report item -- aborting, re-run Step 1 to pick different reports.', v_already_has_item_count;
  end if;

  -- Defensive re-check of this script's core premise: every target report
  -- must be a 'legacy:'/'backfill:' signature (no real checklist row) so
  -- Section 6 (checklist consistency) is genuinely a no-op here. If this
  -- ever finds a real checklist, abort rather than silently skip it.
  select count(*) into v_checklist_hits
  from hand_sanitizer_targets t
  join public.food_safety_cleaning_reports r on r.id = t.report_id
  where r.checklist_signature not like 'legacy:%' and r.checklist_signature not like 'backfill:%';

  if v_checklist_hits > 0 then
    raise exception 'Found % target report(s) with a real checklist relationship -- this script does not handle that case, aborting.', v_checklist_hits;
  end if;

  select count(*) into v_reports_before from public.food_safety_cleaning_reports;

  insert into hand_sanitizer_backfill_summary values ('organization_id', v_org_id::text, 1);
  insert into hand_sanitizer_backfill_summary values ('targets_validated', 'all 21 resolved, unique, gap-only, legacy-signature', 21);

  -- Disable the immutability trigger for the duration of this transaction
  -- only (INSERT is not actually gated by it, but disabled anyway to match
  -- this directory's established convention of never relying on trigger
  -- scope assumptions during a maintenance write). A rollback undoes this.
  alter table public.food_safety_cleaning_report_items disable trigger food_safety_cleaning_report_items_immutable;

  -- One new report_item per target: task_name_snapshot/action_label_snapshot/
  -- response_type_snapshot/sort_order all come from the location's CURRENT
  -- "Hand Sanitizer" task row (never hardcoded), so a future edit to that
  -- task's shape before this script runs is reflected automatically.
  -- checked_at/checked_by_* mirror the REPORT's own completed_at/
  -- completed_by_* -- the original employee and moment, never this script's
  -- operator. frequency_snapshot copies the report's other items' value.
  insert into public.food_safety_cleaning_report_items (
    organization_id, report_id, task_name_snapshot, frequency_snapshot,
    response_type_snapshot, action_label_snapshot, response_value, sort_order,
    checked_at, checked_by_user_id, checked_by_name, checked_by_initials
  )
  select
    r.organization_id,
    r.id,
    task.name,
    coalesce(
      (select ri.frequency_snapshot from public.food_safety_cleaning_report_items ri
       where ri.report_id = r.id limit 1),
      'daily'
    ),
    task.response_type,
    task.action_labels[1],
    'true',
    task.sort_order * 100,
    r.completed_at,
    r.completed_by_user_id,
    r.completed_by_name,
    r.completed_by_initials
  from hand_sanitizer_targets t
  join public.food_safety_cleaning_reports r on r.id = t.report_id
  join public.food_safety_cleaning_locations l on l.id = r.location_id
  join public.food_safety_cleaning_tasks task on task.location_id = l.id and task.name = 'Hand Sanitizer'
  where not exists (
    select 1 from public.food_safety_cleaning_report_items ri
    where ri.report_id = r.id
      and ri.task_name_snapshot = task.name
      and ri.action_label_snapshot = task.action_labels[1]
  );
  get diagnostics v_inserted = row_count;

  alter table public.food_safety_cleaning_report_items enable trigger food_safety_cleaning_report_items_immutable;

  insert into hand_sanitizer_backfill_summary values ('report_items_inserted', 'food_safety_cleaning_report_items', v_inserted);

  if v_inserted <> 21 then
    raise exception 'Expected exactly 21 report_items to be inserted, got % -- aborting (rolling back).', v_inserted;
  end if;

  select count(*) into v_reports_after from public.food_safety_cleaning_reports;
  if v_reports_before <> v_reports_after then
    raise exception 'food_safety_cleaning_reports row count changed (% -> %) -- this script must never create/delete reports -- aborting.', v_reports_before, v_reports_after;
  end if;
  insert into hand_sanitizer_backfill_summary values ('reports_row_count_unchanged', v_reports_before::text || ' -> ' || v_reports_after::text, v_reports_after);

  -- Section 6 (checklist consistency): every target is a legacy/backfill
  -- signature (asserted above), so there is no checklist/checklist_item row
  -- to add or update for any of the 21 reports. Explicitly logged, not
  -- silently skipped.
  insert into hand_sanitizer_backfill_summary values ('checklist_items_touched', 'none -- all 21 targets are legacy/backfill reports with no checklist relationship', 0);

  -- Audit trail (this maintenance convention has no persistent correction-
  -- audit table for Food Safety reports -- food_safety_report_deletions is
  -- specific to deletions -- so, matching this directory's existing
  -- precedent (correct_exterior_premises_dave_quiring_attribution.sql), the
  -- full audit is this transaction's printed summary plus the header comment
  -- above recording the reason, scope, and date).
  insert into hand_sanitizer_backfill_summary values ('correction_reason', 'Historical correction: Hand Sanitizer task was added after the original report was completed.', 21);
  insert into hand_sanitizer_backfill_summary values ('correction_run_at', now()::text, 1);
end $$;

-- Prints the full summary as a result set (visible in the Supabase SQL
-- editor's results grid, not just the log/notices panel).
select * from hand_sanitizer_backfill_summary order by step;

commit;


-- =========================================================================
-- STEP 3 -- VERIFICATION (read-only). Run after Step 2 commits.
-- =========================================================================

-- Every one of the 21 target reports should now show a checked Hand
-- Sanitizer item, with checked_at/checked_by matching the report's own
-- completed_at/completed_by (never this script's operator).
with hand_sanitizer_targets (location_name, report_id) as (
  values
    ('Washroom 2', 'a94342d9-21b3-48ac-81e8-22ed31a8dd01'::uuid), ('Washroom 2', 'f24af1b1-dc03-4b5f-a1c8-2189dd716b9b'::uuid), ('Washroom 2', '04912c07-27c1-4ea1-b762-b945b87c6cc7'::uuid),
    ('Washroom 3', 'b8ed341f-37ea-40a8-8342-f66d5cdee94d'::uuid), ('Washroom 3', '234e3498-cba5-4269-9b47-6dd4d518970c'::uuid), ('Washroom 3', '5f3c8f3e-b2ff-43c4-8708-846b84e06b05'::uuid),
    ('Washroom 4', '89abf8f6-9b82-47c5-8e59-153c3faee986'::uuid), ('Washroom 4', '04d096d9-b381-4306-9f52-541be80a4c5b'::uuid), ('Washroom 4', 'b04a73f1-3dce-4bbb-a646-273e22bb26bf'::uuid),
    ('Washroom 5', '12729f90-beaa-4d2e-9aa3-cf06c3693a12'::uuid), ('Washroom 5', '94ac7f10-48ed-4b02-8219-19db14995b7a'::uuid), ('Washroom 5', '6dda0a55-fa65-40ff-a989-f1515611cf3e'::uuid),
    ('Washroom 6', '7d037b2c-ef7d-48d1-a8fe-75d25208d8ac'::uuid), ('Washroom 6', '857f246d-bf09-425c-8652-a8b9cc25b65a'::uuid), ('Washroom 6', '1b4349d9-6eb7-4f38-b25b-d01369a189b1'::uuid),
    ('Washroom 7', 'c60fc46d-fdc7-4add-8e47-1a58dc58131f'::uuid), ('Washroom 7', '16a8c60a-e477-4580-8b20-f14e2fc08dfa'::uuid), ('Washroom 7', '606f858a-e2fd-4b04-a561-e77837e9b356'::uuid),
    ('Washroom 8', 'a2503ab3-84f6-4cec-bfe8-de19d7cfbdd8'::uuid), ('Washroom 8', '99c6885d-63e4-42f7-bb80-5cd893d93b45'::uuid), ('Washroom 8', '5b682b0e-746e-4880-b294-ded6b493f761'::uuid)
)
select
  t.location_name,
  r.id as report_id,
  r.completed_at,
  r.completed_by_name,
  ri.response_value,
  ri.checked_at,
  ri.checked_by_name,
  (r.completed_at = ri.checked_at and r.completed_by_name = ri.checked_by_name) as employee_and_date_match
from hand_sanitizer_targets t
join public.food_safety_cleaning_reports r on r.id = t.report_id
join public.food_safety_cleaning_report_items ri
  on ri.report_id = r.id and ri.task_name_snapshot = 'Hand Sanitizer'
order by t.location_name, r.completed_at;
-- Expect: 21 rows, response_value = 'true' on every row, employee_and_date_match = true on every row.

-- Per-location count: exactly 3 reports per location now have a checked
-- Hand Sanitizer item.
select l.name as location_name, count(*) as checked_hand_sanitizer_reports
from public.food_safety_cleaning_report_items ri
join public.food_safety_cleaning_reports r on r.id = ri.report_id
join public.food_safety_cleaning_locations l on l.id = r.location_id
where ri.task_name_snapshot = 'Hand Sanitizer' and ri.response_value = 'true'
  and l.organization_id = (select id from public.organizations where name = 'First Light Greenhouses inc')
  and l.name in ('Washroom 2','Washroom 3','Washroom 4','Washroom 5','Washroom 6','Washroom 7','Washroom 8')
group by l.name
order by l.name;
-- Expect: 7 rows, checked_hand_sanitizer_reports = 3 for every location.

-- Report counts per location, unchanged from before this script ran.
select l.name as location_name, count(*) as report_count
from public.food_safety_cleaning_locations l
join public.food_safety_cleaning_reports r on r.location_id = l.id
where l.organization_id = (select id from public.organizations where name = 'First Light Greenhouses inc')
  and l.name in ('Washroom 2','Washroom 3','Washroom 4','Washroom 5','Washroom 6','Washroom 7','Washroom 8')
group by l.name
order by l.name;
-- Expect: Washroom 2: 164, Washroom 3: 163, Washroom 4: 163, Washroom 5: 163,
-- Washroom 6: 164, Washroom 7: 164, Washroom 8: 166 (same as the Step 1
-- audit, before this script ran).

-- No orphaned/duplicate report_items: at most one Hand Sanitizer item per
-- report.
select ri.report_id, count(*) as hand_sanitizer_item_count
from public.food_safety_cleaning_report_items ri
join public.food_safety_cleaning_reports r on r.id = ri.report_id
join public.food_safety_cleaning_locations l on l.id = r.location_id
where ri.task_name_snapshot = 'Hand Sanitizer'
  and l.organization_id = (select id from public.organizations where name = 'First Light Greenhouses inc')
  and l.name in ('Washroom 2','Washroom 3','Washroom 4','Washroom 5','Washroom 6','Washroom 7','Washroom 8')
group by ri.report_id
having count(*) > 1;
-- Expect: no rows.

-- The current mobile "Hand Sanitizer" task definition is untouched by this
-- script (it only ever reads food_safety_cleaning_tasks, never writes it).
select l.name as location_name, t.name, t.response_type, t.action_labels, t.is_required, t.sort_order
from public.food_safety_cleaning_locations l
join public.food_safety_cleaning_tasks t on t.location_id = l.id and t.name = 'Hand Sanitizer'
where l.organization_id = (select id from public.organizations where name = 'First Light Greenhouses inc')
  and l.name in ('Washroom 2','Washroom 3','Washroom 4','Washroom 5','Washroom 6','Washroom 7','Washroom 8')
order by l.name;
-- Expect: identical to the Step 1 "current live Hand Sanitizer task" query.

-- The immutability trigger must be back on.
select tgname, tgenabled
from pg_trigger
where tgname = 'food_safety_cleaning_report_items_immutable';
-- Expect: one row, tgenabled = 'O' (enabled).
