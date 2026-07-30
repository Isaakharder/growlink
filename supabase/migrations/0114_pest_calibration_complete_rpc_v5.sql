-- Pest Control device Calibration module — completion RPC (v5).
--
-- Adds p_effective_date (the validated, server-revalidated performed date —
-- see server/src/routes/pestCalibration/services/effectiveDate.ts) to the
-- record insert. completed_at/created_at are unchanged and still reflect
-- the real submission/insertion instant — only effective_date carries the
-- (possibly backdated) performed date. Otherwise identical to v4: still one
-- plpgsql function body = one atomic transaction, still idempotent via
-- completion_request_id + ON CONFLICT DO NOTHING short-circuit, still
-- service_role-only EXECUTE.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'pest_calibration_complete_record'
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

create function public.pest_calibration_complete_record(
  p_organization_id           uuid,
  p_device_id                 uuid,
  p_template_id               uuid,
  p_completion_request_id     uuid,
  p_device_name_snapshot      text,
  p_device_identification_number_snapshot text,
  p_device_area_snapshot      text,
  p_device_frequency_snapshot jsonb,
  p_instructions_snapshot     text,
  p_effective_date            date,
  p_completed_by_user_id      uuid,
  p_completed_by_name         text,
  p_completed_at              timestamptz,
  p_next_due_at               timestamptz,
  p_answers                   jsonb, -- array of flat-field answer objects (task-stamped)
  p_repeating_rows            jsonb  -- array of {row: {task_id, task_name_snapshot, task_sort_order, row_index}, answers: [...]}
)
returns uuid
language plpgsql
as $$
declare
  v_record_id uuid;
  v_row jsonb;
  v_answer jsonb;
  v_repeating_row_id uuid;
begin
  insert into public.pest_calibration_records (
    organization_id, device_id, template_id, completion_request_id,
    device_name_snapshot, device_identification_number_snapshot, device_area_snapshot,
    device_frequency_snapshot, instructions_snapshot, effective_date,
    completed_by_user_id, completed_by_name, completed_at, next_due_at
  ) values (
    p_organization_id, p_device_id, p_template_id, p_completion_request_id,
    p_device_name_snapshot, p_device_identification_number_snapshot, p_device_area_snapshot,
    p_device_frequency_snapshot, p_instructions_snapshot, p_effective_date,
    p_completed_by_user_id, p_completed_by_name, p_completed_at, p_next_due_at
  )
  on conflict (organization_id, completion_request_id) do nothing
  returning id into v_record_id;

  if v_record_id is null then
    -- Idempotent retry / double-submit — return the existing record id
    -- without repeating any of the inserts/updates below.
    select id into v_record_id
    from public.pest_calibration_records
    where organization_id = p_organization_id
      and completion_request_id = p_completion_request_id;

    return v_record_id;
  end if;

  insert into public.pest_calibration_record_answers (
    organization_id, record_id, task_id, task_name_snapshot, task_sort_order, template_field_id,
    field_label_snapshot, field_type_snapshot, help_text_snapshot, placeholder_snapshot, unit_snapshot,
    min_value_snapshot, max_value_snapshot, decimal_precision_snapshot, choice_options_snapshot,
    is_required_snapshot, sort_order,
    value_text, value_number, value_boolean, value_date, value_choices, is_within_range
  )
  select
    p_organization_id, v_record_id,
    (a->>'task_id')::uuid, a->>'task_name_snapshot', coalesce((a->>'task_sort_order')::integer, 0),
    (a->>'template_field_id')::uuid,
    a->>'field_label_snapshot', a->>'field_type_snapshot', a->>'help_text_snapshot', a->>'placeholder_snapshot', a->>'unit_snapshot',
    (a->>'min_value_snapshot')::numeric, (a->>'max_value_snapshot')::numeric,
    (a->>'decimal_precision_snapshot')::integer, a->'choice_options_snapshot',
    coalesce((a->>'is_required_snapshot')::boolean, false), coalesce((a->>'sort_order')::integer, 0),
    a->>'value_text', (a->>'value_number')::numeric, (a->>'value_boolean')::boolean,
    (a->>'value_date')::date, a->'value_choices', (a->>'is_within_range')::boolean
  from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) as a;

  for v_row in select * from jsonb_array_elements(coalesce(p_repeating_rows, '[]'::jsonb))
  loop
    insert into public.pest_calibration_record_repeating_rows (
      organization_id, record_id, task_id, task_name_snapshot, task_sort_order, row_index
    ) values (
      p_organization_id, v_record_id,
      ((v_row->'row')->>'task_id')::uuid,
      (v_row->'row')->>'task_name_snapshot',
      coalesce(((v_row->'row')->>'task_sort_order')::integer, 0),
      coalesce(((v_row->'row')->>'row_index')::integer, 0)
    )
    returning id into v_repeating_row_id;

    for v_answer in select * from jsonb_array_elements(coalesce(v_row->'answers', '[]'::jsonb))
    loop
      insert into public.pest_calibration_record_repeating_answers (
        organization_id, repeating_row_id, template_field_id,
        field_label_snapshot, field_type_snapshot, help_text_snapshot, placeholder_snapshot, unit_snapshot,
        min_value_snapshot, max_value_snapshot, decimal_precision_snapshot, choice_options_snapshot,
        is_required_snapshot, sort_order,
        value_text, value_number, value_boolean, value_date, value_choices, is_within_range
      ) values (
        p_organization_id, v_repeating_row_id, (v_answer->>'template_field_id')::uuid,
        v_answer->>'field_label_snapshot', v_answer->>'field_type_snapshot', v_answer->>'help_text_snapshot', v_answer->>'placeholder_snapshot', v_answer->>'unit_snapshot',
        (v_answer->>'min_value_snapshot')::numeric, (v_answer->>'max_value_snapshot')::numeric,
        (v_answer->>'decimal_precision_snapshot')::integer, v_answer->'choice_options_snapshot',
        coalesce((v_answer->>'is_required_snapshot')::boolean, false), coalesce((v_answer->>'sort_order')::integer, 0),
        v_answer->>'value_text', (v_answer->>'value_number')::numeric, (v_answer->>'value_boolean')::boolean,
        (v_answer->>'value_date')::date, v_answer->'value_choices', (v_answer->>'is_within_range')::boolean
      );
    end loop;
  end loop;

  update public.pest_calibration_devices
  set last_completed_at = p_completed_at,
      next_due_at = p_next_due_at,
      updated_at = now()
  where id = p_device_id
    and organization_id = p_organization_id;

  return v_record_id;
end;
$$;

revoke execute on function public.pest_calibration_complete_record(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, text, date,
  uuid, text, timestamptz, timestamptz, jsonb, jsonb
) from public;

grant execute on function public.pest_calibration_complete_record(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, text, date,
  uuid, text, timestamptz, timestamptz, jsonb, jsonb
) to service_role;
