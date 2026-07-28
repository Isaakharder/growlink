-- Allow more than one completed Food Safety report per location per day
-- (packline swab-test retest workflow: fail, re-clean, re-test, log a
-- second complete report for the same location/date).
--
-- Previously food_safety_cleaning_checklists had one row per (location_id,
-- period_type, period_key), and food_safety_cleaning_reports had one row
-- per (location_id, period_signature) -- both hard "one per day" gates.
-- This migration introduces checklist "attempts": a location can now have
-- multiple checklist rows for the same period, and each attempt produces
-- its own independent, immutable report, keyed by the exact set of
-- checklist ids that produced it (never by date), so two devices racing to
-- start/complete different attempts can never collide with each other.

alter table public.food_safety_cleaning_checklists
  add column if not exists attempt_number integer not null default 1;

alter table public.food_safety_cleaning_checklists
  drop constraint if exists food_safety_cleaning_checklists_location_period_key;

alter table public.food_safety_cleaning_checklists
  add constraint food_safety_cleaning_checklists_location_period_attempt_key
    unique (location_id, period_type, period_key, attempt_number);

-- Backs "give me the latest attempt for this location+period" lookups
-- (get_or_create, start_new_attempt, currentChecklists.ts, loadLocationCards).
create index if not exists food_safety_cleaning_checklists_location_attempt_idx
  on public.food_safety_cleaning_checklists (location_id, period_type, period_key, attempt_number desc);


-- Recreated to select the LATEST attempt instead of relying on a single
-- unique row per period -- otherwise unchanged: still auto-creates attempt 1
-- the first time, still guarded by the same advisory lock so two concurrent
-- callers can never both create attempt 1.
create or replace function public.food_safety_get_or_create_checklist(
  p_organization_id uuid,
  p_location_id uuid,
  p_period_type text,
  p_period_key text
)
returns uuid
language plpgsql
as $$
declare
  v_checklist_id uuid;
  v_remaining integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_location_id::text || ':' || p_period_type || ':' || p_period_key, 3));

  select id into v_checklist_id
  from public.food_safety_cleaning_checklists
  where location_id = p_location_id and period_type = p_period_type and period_key = p_period_key
  order by attempt_number desc
  limit 1;

  if v_checklist_id is not null then
    return v_checklist_id;
  end if;

  insert into public.food_safety_cleaning_checklists (
    organization_id, location_id, period_type, period_key, status, attempt_number
  ) values (
    p_organization_id, p_location_id, p_period_type, p_period_key, 'incomplete', 1
  )
  returning id into v_checklist_id;

  insert into public.food_safety_cleaning_checklist_items (
    checklist_id, organization_id, task_id, task_name_snapshot, frequency_snapshot,
    response_type_snapshot, action_label_snapshot, is_required_snapshot, number_unit_snapshot,
    sort_order, is_complete
  )
  select
    v_checklist_id, p_organization_id, t.id, t.name, p_period_type,
    t.response_type, label.value, t.is_required, t.number_unit,
    (t.sort_order * 100) + (label.ordinality - 1), false
  from public.food_safety_cleaning_tasks t
  cross join lateral unnest(coalesce(t.action_labels, array[null]::text[])) with ordinality as label(value, ordinality)
  where t.location_id = p_location_id;

  select count(*) into v_remaining
  from public.food_safety_cleaning_checklist_items
  where checklist_id = v_checklist_id and is_required_snapshot = true and is_complete = false;

  if v_remaining = 0 then
    update public.food_safety_cleaning_checklists
    set status = 'complete', completed_at = now()
    where id = v_checklist_id;
  end if;

  return v_checklist_id;
end;
$$;


-- New: "Complete Another Report". Only callable once the current latest
-- attempt for this location+period is complete -- starts a fresh incomplete
-- checklist (its own attempt_number, its own blank items) that the mobile
-- page can then fill out and complete independently, without ever touching
-- the prior attempt's rows. Uses the SAME advisory lock key as
-- get_or_create_checklist, so it's serialized against both concurrent
-- get_or_create calls and concurrent calls to itself -- no retry loop
-- needed to compute the next attempt_number safely.
create or replace function public.food_safety_start_new_checklist_attempt(
  p_organization_id uuid,
  p_location_id uuid,
  p_period_type text,
  p_period_key text
)
returns uuid
language plpgsql
as $$
declare
  v_latest_status text;
  v_latest_attempt integer;
  v_next_attempt integer;
  v_checklist_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_location_id::text || ':' || p_period_type || ':' || p_period_key, 3));

  select status, attempt_number into v_latest_status, v_latest_attempt
  from public.food_safety_cleaning_checklists
  where location_id = p_location_id and period_type = p_period_type and period_key = p_period_key
  order by attempt_number desc
  limit 1;

  if v_latest_status is distinct from 'complete' then
    raise exception 'A checklist is already in progress for this period.'
      using errcode = 'GL002';
  end if;

  v_next_attempt := v_latest_attempt + 1;

  insert into public.food_safety_cleaning_checklists (
    organization_id, location_id, period_type, period_key, status, attempt_number
  ) values (
    p_organization_id, p_location_id, p_period_type, p_period_key, 'incomplete', v_next_attempt
  )
  returning id into v_checklist_id;

  insert into public.food_safety_cleaning_checklist_items (
    checklist_id, organization_id, task_id, task_name_snapshot, frequency_snapshot,
    response_type_snapshot, action_label_snapshot, is_required_snapshot, number_unit_snapshot,
    sort_order, is_complete
  )
  select
    v_checklist_id, p_organization_id, t.id, t.name, p_period_type,
    t.response_type, label.value, t.is_required, t.number_unit,
    (t.sort_order * 100) + (label.ordinality - 1), false
  from public.food_safety_cleaning_tasks t
  cross join lateral unnest(coalesce(t.action_labels, array[null]::text[])) with ordinality as label(value, ordinality)
  where t.location_id = p_location_id;

  return v_checklist_id;
end;
$$;

grant execute on function public.food_safety_start_new_checklist_attempt(uuid, uuid, text, text) to service_role;


-- Report idempotency moves from "one per (location, period)" to "one per
-- (location, exact set of checklist attempts that produced it)" -- this is
-- what lets two independent attempts each produce their own report while
-- still keeping report creation idempotent against a single attempt being
-- raced by two devices. Existing rows predate attempt-tracking and never
-- recorded which checklist ids produced them, so they're backfilled with a
-- filler value derived from their own (always-unique) row id -- not a real
-- reconstruction, just satisfying the new NOT NULL + UNIQUE requirement for
-- history that already existed before this migration.
alter table public.food_safety_cleaning_reports
  add column if not exists checklist_signature text;

-- The reports table's immutability trigger (food_safety_reports_prevent_mutation,
-- migration 0090) unconditionally rejects any UPDATE other than the
-- location-delete-cascade's location_id -> null transition -- it would
-- reject this one-time backfill UPDATE too (verified against a real
-- Postgres instance seeded with pre-existing report rows: the statement
-- below fails with "This row is part of an immutable Food Safety report..."
-- unless the trigger is disabled first). Disabling it for just this single
-- statement, in the same transaction, keeps the guarantee that no
-- application code can ever update a report fully intact -- only this one
-- deliberate migration statement bypasses it, and only once.
alter table public.food_safety_cleaning_reports disable trigger food_safety_cleaning_reports_immutable;

update public.food_safety_cleaning_reports
  set checklist_signature = 'legacy:' || id::text
  where checklist_signature is null;

alter table public.food_safety_cleaning_reports enable trigger food_safety_cleaning_reports_immutable;

alter table public.food_safety_cleaning_reports
  alter column checklist_signature set not null;

alter table public.food_safety_cleaning_reports
  drop constraint if exists food_safety_cleaning_reports_location_period_key;

alter table public.food_safety_cleaning_reports
  add constraint food_safety_cleaning_reports_location_checklist_sig_key
    unique (location_id, checklist_signature);
