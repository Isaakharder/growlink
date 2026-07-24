-- Manual location completion + separate inspection tracking.
--
-- Previously a checklist auto-finalized the instant its last required item's
-- response became valid. That's wrong for tasks like "Soap" where checking
-- it and finding it already full is a legitimate outcome that needs no
-- action — forcing every checkbox to be checked made that impossible to
-- record. Now each item tracks two independent things:
--   - is_inspected:        the task was looked at (gates completion)
--   - is_action_complete:  the configured action was actually performed
--                          (renamed from is_complete — purely informational
--                          now, never gates anything)
-- A location is only finalized when a human presses "Complete Location",
-- which requires every currently-due item to be inspected but does NOT
-- require every action to be complete.

alter table public.food_safety_cleaning_checklist_items
  rename column is_complete to is_action_complete;

alter table public.food_safety_cleaning_checklist_items
  add column if not exists is_inspected boolean not null default false,
  add column if not exists inspected_at timestamptz,
  add column if not exists inspected_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists inspected_by_name text,
  add column if not exists inspected_by_initials text;

alter table public.food_safety_cleaning_report_items
  add column if not exists is_action_complete boolean not null default false,
  add column if not exists is_inspected boolean not null default false,
  add column if not exists inspected_at timestamptz,
  add column if not exists inspected_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists inspected_by_name text,
  add column if not exists inspected_by_initials text;

-- Recreate checklist provisioning with the renamed column and the new
-- vacuous-completion check (0 items, or nothing left uninspected — the
-- latter is unreachable for a freshly created checklist since every new
-- item starts uninspected, but keeps the check meaningfully named).
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
  where location_id = p_location_id and period_type = p_period_type and period_key = p_period_key;

  if v_checklist_id is not null then
    return v_checklist_id;
  end if;

  insert into public.food_safety_cleaning_checklists (
    organization_id, location_id, period_type, period_key, status
  ) values (
    p_organization_id, p_location_id, p_period_type, p_period_key, 'incomplete'
  )
  returning id into v_checklist_id;

  insert into public.food_safety_cleaning_checklist_items (
    checklist_id, organization_id, task_id, task_name_snapshot, frequency_snapshot,
    response_type_snapshot, action_label_snapshot, is_required_snapshot, number_unit_snapshot,
    sort_order, is_action_complete, is_inspected
  )
  select
    v_checklist_id, p_organization_id, t.id, t.name, t.frequency,
    t.response_type, t.action_label, t.is_required, t.number_unit,
    t.sort_order, false, false
  from public.food_safety_cleaning_tasks t
  where t.location_id = p_location_id and t.frequency = p_period_type;

  select count(*) into v_remaining
  from public.food_safety_cleaning_checklist_items
  where checklist_id = v_checklist_id and is_inspected = false;

  if v_remaining = 0 then
    update public.food_safety_cleaning_checklists
    set status = 'complete', completed_at = now()
    where id = v_checklist_id;
  end if;

  return v_checklist_id;
end;
$$;

-- Sets a task's response value/action-complete state. No longer touches
-- checklist status at all — completion is exclusively manual now (see
-- food_safety_complete_location_checklists below). Still blocks any change
-- once the checklist is finalized, with the same idempotent-replay
-- allowance as before (an identical resubmission of an already-applied
-- value is a silent no-op, so offline retries stay safe).
create or replace function public.food_safety_set_checklist_item_response(
  p_organization_id uuid,
  p_item_id uuid,
  p_response_value text,
  p_actor_user_id uuid,
  p_actor_name text,
  p_actor_initials text
)
returns public.food_safety_cleaning_checklists
language plpgsql
as $$
declare
  v_checklist_id uuid;
  v_response_type text;
  v_current_value text;
  v_current_complete boolean;
  v_new_complete boolean;
  v_checklist public.food_safety_cleaning_checklists;
  v_now timestamptz := now();
begin
  select checklist_id, response_type_snapshot, response_value, is_action_complete
    into v_checklist_id, v_response_type, v_current_value, v_current_complete
  from public.food_safety_cleaning_checklist_items
  where id = p_item_id and organization_id = p_organization_id;

  if v_checklist_id is null then
    raise exception 'Checklist item % not found in organization %', p_item_id, p_organization_id using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_checklist_id::text, 4));

  select * into v_checklist
  from public.food_safety_cleaning_checklists
  where id = v_checklist_id
  for update;

  v_new_complete := case v_response_type
    when 'checkbox' then (p_response_value = 'true')
    when 'number' then (p_response_value is not null and trim(p_response_value) ~ '^-?\d+(\.\d+)?$')
    else (p_response_value is not null and length(trim(p_response_value)) > 0)
  end;

  if v_checklist.status = 'complete' then
    if v_new_complete = v_current_complete and coalesce(p_response_value, '') = coalesce(v_current_value, '') then
      return v_checklist;
    end if;
    raise exception 'This cleaning checklist has already been finalized and cannot be changed.'
      using errcode = '42501';
  end if;

  update public.food_safety_cleaning_checklist_items
  set response_value = p_response_value,
      is_action_complete = v_new_complete,
      checked_at = v_now,
      checked_by_user_id = p_actor_user_id,
      checked_by_name = p_actor_name,
      checked_by_initials = p_actor_initials,
      updated_at = v_now
  where id = p_item_id;

  return v_checklist;
end;
$$;

-- New: sets a task's inspected state. Same locking/idempotent-replay/
-- finalized-lock rules as the response function above, but never touches
-- response_value/is_action_complete and never finalizes the checklist.
create or replace function public.food_safety_set_checklist_item_inspection(
  p_organization_id uuid,
  p_item_id uuid,
  p_is_inspected boolean,
  p_actor_user_id uuid,
  p_actor_name text,
  p_actor_initials text
)
returns public.food_safety_cleaning_checklists
language plpgsql
as $$
declare
  v_checklist_id uuid;
  v_current_inspected boolean;
  v_checklist public.food_safety_cleaning_checklists;
  v_now timestamptz := now();
begin
  select checklist_id, is_inspected
    into v_checklist_id, v_current_inspected
  from public.food_safety_cleaning_checklist_items
  where id = p_item_id and organization_id = p_organization_id;

  if v_checklist_id is null then
    raise exception 'Checklist item % not found in organization %', p_item_id, p_organization_id using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_checklist_id::text, 4));

  select * into v_checklist
  from public.food_safety_cleaning_checklists
  where id = v_checklist_id
  for update;

  if v_checklist.status = 'complete' then
    if p_is_inspected = v_current_inspected then
      return v_checklist;
    end if;
    raise exception 'This cleaning checklist has already been finalized and cannot be changed.'
      using errcode = '42501';
  end if;

  update public.food_safety_cleaning_checklist_items
  set is_inspected = p_is_inspected,
      inspected_at = v_now,
      inspected_by_user_id = p_actor_user_id,
      inspected_by_name = p_actor_name,
      inspected_by_initials = p_actor_initials,
      updated_at = v_now
  where id = p_item_id;

  return v_checklist;
end;
$$;

-- New: the "Complete Location" button. p_checklist_ids is the caller-computed
-- set of currently-due checklists for one location (period_key matching is
-- timezone-aware and lives in TypeScript, not SQL — see checklistPeriod.ts —
-- so it's passed in rather than recomputed here). Locks every named
-- checklist (consistent id order avoids deadlocking against a concurrent
-- call touching an overlapping set), requires every one of their items to
-- be inspected, then finalizes any that aren't already complete. Already-
-- complete checklists in the set are left untouched (idempotent replay —
-- e.g. an offline-queued duplicate tap).
create or replace function public.food_safety_complete_location_checklists(
  p_organization_id uuid,
  p_checklist_ids uuid[],
  p_actor_user_id uuid,
  p_actor_name text,
  p_actor_initials text
)
returns void
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_uninspected_count integer;
begin
  perform id
  from public.food_safety_cleaning_checklists
  where id = any(p_checklist_ids) and organization_id = p_organization_id
  order by id
  for update;

  select count(*) into v_uninspected_count
  from public.food_safety_cleaning_checklist_items i
  join public.food_safety_cleaning_checklists c on c.id = i.checklist_id
  where i.checklist_id = any(p_checklist_ids)
    and c.organization_id = p_organization_id
    and c.status <> 'complete'
    and i.is_inspected = false;

  if v_uninspected_count > 0 then
    -- GL001 is a GrowLink-specific application code (not a reserved Postgres
    -- SQLSTATE) so the Express layer can map it to a precise 400 without
    -- colliding with a built-in meaning like P0004 (assert_failure).
    raise exception 'Please inspect every task before completing this location.'
      using errcode = 'GL001';
  end if;

  update public.food_safety_cleaning_checklists
  set status = 'complete',
      completed_at = v_now,
      completed_by_user_id = p_actor_user_id,
      completed_by_name = p_actor_name,
      completed_by_initials = p_actor_initials,
      updated_at = v_now
  where id = any(p_checklist_ids)
    and organization_id = p_organization_id
    and status <> 'complete';
end;
$$;

grant execute on function public.food_safety_set_checklist_item_inspection(uuid, uuid, boolean, uuid, text, text) to service_role;
grant execute on function public.food_safety_complete_location_checklists(uuid, uuid[], uuid, text, text) to service_role;
