-- Moves cleaning-task frequency from the task level to the location level
-- (every task at a location now runs on the same Daily/Weekly/Monthly/
-- Annually cycle), and adds an optional free-text Notes field to locations.
--
-- Confirmed via a pre-migration audit query that no existing location has
-- tasks spanning more than one distinct frequency, so the backfill below is
-- lossless — every location's new frequency column is set from the (single,
-- unambiguous) frequency its tasks already shared.

alter table public.food_safety_cleaning_locations
  add column if not exists notes text,
  add column if not exists frequency text;

update public.food_safety_cleaning_locations l
set frequency = coalesce(
  (
    select t.frequency
    from public.food_safety_cleaning_tasks t
    where t.location_id = l.id
    order by t.sort_order
    limit 1
  ),
  'daily'
)
where l.frequency is null;

alter table public.food_safety_cleaning_locations
  alter column frequency set not null,
  add constraint food_safety_cleaning_locations_frequency_check
    check (frequency in ('daily', 'weekly', 'monthly', 'annually'));

-- Recreate checklist provisioning to take its frequency entirely from the
-- location (p_period_type, supplied by the caller) instead of filtering
-- tasks by their own frequency column, which no longer exists after this
-- migration — every task at a location now belongs to its one checklist.
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

-- food_safety_cleaning_tasks.frequency is now fully redundant (confirmed to
-- have no other reader: this was the only DB function referencing the
-- table). Its check constraint is dropped automatically with the column.
alter table public.food_safety_cleaning_tasks
  drop column if exists frequency;
