-- Bug fix: unchecking any checkbox task in the mobile Food Safety app always
-- failed with a not-null constraint violation on is_complete.
--
-- food_safety_set_checklist_item_response computed:
--   v_new_complete := case v_response_type when 'checkbox' then (p_response_value = 'true') ... end
-- In SQL, `NULL = 'true'` evaluates to NULL, not false. Unchecking a task
-- calls this RPC with p_response_value = null (see mobileCleaningChecklist.ts's
-- /uncheck route), so v_new_complete became NULL, and the subsequent
-- `update ... set is_complete = v_new_complete` violated is_complete's
-- `NOT NULL` constraint (23502) on every single uncheck attempt, for every
-- checkbox task, since the checkbox response type was introduced in
-- migration 0087. This has been present through 0087, 0089, and 0091's
-- copies of this function.
--
-- Fix: coalesce the checkbox branch to false when p_response_value is null,
-- matching the same "null means not checked" semantics already used
-- everywhere else (server-side isItemChecked, the client's taskChecks
-- computation, and this same function's own `number`/text branches, which
-- already guard against a null p_response_value explicitly).

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
    when 'checkbox' then coalesce(p_response_value = 'true', false)
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
