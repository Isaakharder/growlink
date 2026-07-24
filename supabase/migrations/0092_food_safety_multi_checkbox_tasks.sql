-- Allow a checkbox task to track more than one independently-checkable
-- action (e.g. "Garbage Bin" needing both "Emptied" and "Bag Replaced"
-- tracked separately, but shown together under one task heading).
--
-- action_label becomes action_labels (an ordered array). At checklist-
-- creation time each label expands into its own checklist item — its own
-- audit trail, its own report column — sharing the same task_name_snapshot
-- so the mobile page and reports table group them under one heading.
-- checklist_items/report_items need no schema change: they already store
-- one row per checkable action via action_label_snapshot; a task with
-- multiple labels just now expands into more rows than before.

alter table public.food_safety_cleaning_tasks
  add column if not exists action_labels text[];

update public.food_safety_cleaning_tasks
  set action_labels = array[action_label]
  where action_label is not null and action_labels is null;

alter table public.food_safety_cleaning_tasks
  drop column if exists action_label;

-- sort_order is scaled by 100 and offset by each label's position so
-- multiple items expanded from one task stay adjacent and in the
-- configured label order, without colliding with neighboring tasks'
-- sort_order values (comfortably supports up to 100 checkboxes per task).
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
    t.response_type, label.value, t.is_required, t.number_unit,
    (t.sort_order * 100) + (label.ordinality - 1), false
  from public.food_safety_cleaning_tasks t
  cross join lateral unnest(coalesce(t.action_labels, array[null]::text[])) with ordinality as label(value, ordinality)
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
