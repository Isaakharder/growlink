-- Revert of migration 0089's separate "Inspected" checkbox concept — the
-- product decision was withdrawn. Back to one checkbox per configured task.
-- The manual "Complete Location" button (also introduced in 0089) stays,
-- but now completes unconditionally: pressing it locks in whatever is
-- currently checked/unchecked, with no validation at all.

alter table public.food_safety_cleaning_checklist_items
  rename column is_action_complete to is_complete;

alter table public.food_safety_cleaning_checklist_items
  drop column if exists is_inspected,
  drop column if exists inspected_at,
  drop column if exists inspected_by_user_id,
  drop column if exists inspected_by_name,
  drop column if exists inspected_by_initials;

alter table public.food_safety_cleaning_report_items
  drop column if exists is_action_complete,
  drop column if exists is_inspected,
  drop column if exists inspected_at,
  drop column if exists inspected_by_user_id,
  drop column if exists inspected_by_name,
  drop column if exists inspected_by_initials;

drop function if exists public.food_safety_set_checklist_item_inspection(uuid, uuid, boolean, uuid, text, text);

-- Restored to the migration-0087 shape (is_complete instead of
-- is_action_complete), unchanged otherwise: an empty checklist (no tasks of
-- that frequency) is still vacuously complete at creation time.
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
    sort_order, is_complete
  )
  select
    v_checklist_id, p_organization_id, t.id, t.name, t.frequency,
    t.response_type, t.action_label, t.is_required, t.number_unit,
    t.sort_order, false
  from public.food_safety_cleaning_tasks t
  where t.location_id = p_location_id and t.frequency = p_period_type;

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

-- Sets a task's response value/checked state. Still never auto-finalizes
-- the checklist (that stays exclusively manual) and still blocks any change
-- once the checklist is finalized, with the same idempotent-replay
-- allowance for offline retries.
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
  select checklist_id, response_type_snapshot, response_value, is_complete
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
      is_complete = v_new_complete,
      checked_at = v_now,
      checked_by_user_id = p_actor_user_id,
      checked_by_name = p_actor_name,
      checked_by_initials = p_actor_initials,
      updated_at = v_now
  where id = p_item_id;

  return v_checklist;
end;
$$;

-- "Complete Location" now finalizes unconditionally — no inspection (or any
-- other) requirement. Whatever is currently checked/unchecked is what gets
-- locked in. Already-complete checklists in the set are left untouched
-- (idempotent replay, e.g. an offline-queued duplicate tap).
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
begin
  perform id
  from public.food_safety_cleaning_checklists
  where id = any(p_checklist_ids) and organization_id = p_organization_id
  order by id
  for update;

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
