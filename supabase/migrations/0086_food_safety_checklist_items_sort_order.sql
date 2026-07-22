-- Preserve the admin-configured task order (food_safety_cleaning_tasks.sort_order)
-- on checklist items so the mobile card lists tasks in the same order they
-- were set up in, not an arbitrary/insertion order.

alter table public.food_safety_cleaning_checklist_items
  add column if not exists sort_order integer not null default 0;

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
  v_item_count integer;
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
    checklist_id, organization_id, task_id, task_name_snapshot, frequency_snapshot, sort_order, is_complete
  )
  select v_checklist_id, p_organization_id, t.id, t.name, t.frequency, t.sort_order, false
  from public.food_safety_cleaning_tasks t
  where t.location_id = p_location_id and t.frequency = p_period_type;

  get diagnostics v_item_count = row_count;

  if v_item_count = 0 then
    update public.food_safety_cleaning_checklists
    set status = 'complete', completed_at = now()
    where id = v_checklist_id;
  end if;

  return v_checklist_id;
end;
$$;
