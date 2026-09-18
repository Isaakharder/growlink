-- Fixes two bugs discovered while writing integration tests for the
-- Maintenance module (0127-0130), neither caught by the type-checker since
-- both are runtime/behavioral:
--
-- 1. `errcode = '40001'` (Postgres's reserved SQLSTATE class "40" —
--    transaction_rollback / serialization_failure) triggers automatic
--    retry behavior somewhere in the Supabase connection-pooling stack:
--    a real test against the hosted project showed a call to
--    maintenance_complete_schedule that legitimately raises this code
--    (a genuine, expected business-logic conflict, not a transient
--    serialization race) take ~125 SECONDS to return, ultimately failing
--    with a raw "upstream request timeout" instead of the intended fast
--    409. The exact same test scenario using errcode '22023' (a
--    plain, non-reserved-class code) returns in under a second. This
--    codebase already has a precedent for exactly this situation —
--    food_safety_complete_location_checklists (0089) uses a custom
--    'GL001' code specifically because "GL001 is a GrowLink-specific
--    application code (not a reserved Postgres SQLSTATE) so the Express
--    layer can map it to a precise 400 without colliding with a built-in
--    meaning." Both RPCs below are switched to their own custom codes,
--    matching that convention:
--      - maintenance_complete_schedule's stale-occurrence race -> 'GL020'
--      - maintenance_confirm_stock_count_session's conflict -> 'GL021'
--
-- 2. maintenance_receive_restock_line validated the receive amount against
--    requested_quantity - received_quantity using the CURRENT (already
--    mutated) received_quantity even when the call was actually a retry
--    of an already-applied receipt — so retrying an already-fully-applied
--    receive was incorrectly rejected as "exceeds what remains" instead of
--    being recognized as a safe no-op replay. Fixed by checking the
--    ledger's own idempotency key (maintenance_inventory_transactions.
--    request_id) directly, BEFORE running the remaining-quantity
--    validation, and short-circuiting to the current state on a replay —
--    the same idempotent-early-return shape already used correctly by
--    maintenance_apply_inventory_transaction and maintenance_complete_
--    schedule (both check their own idempotency key before any
--    validation, which is why neither has this bug).

create or replace function public.maintenance_complete_schedule(
  p_organization_id uuid,
  p_schedule_id uuid,
  p_completion_request_id uuid,
  p_expected_occurrence_index integer,
  p_next_occurrence_index integer,
  p_next_due_date date,
  p_completed_by uuid,
  p_completed_by_name text,
  p_completed_at timestamptz,
  p_meter_reading_value numeric,
  p_meter_reading_unit_snapshot text,
  p_notes text,
  p_checklist_snapshot jsonb
)
returns public.maintenance_schedule_completions
language plpgsql
as $$
declare
  v_schedule public.maintenance_schedules;
  v_completion public.maintenance_schedule_completions;
begin
  select * into v_completion
  from public.maintenance_schedule_completions
  where organization_id = p_organization_id and completion_request_id = p_completion_request_id;

  if v_completion.id is not null then
    return v_completion; -- idempotent replay
  end if;

  select * into v_schedule
  from public.maintenance_schedules
  where id = p_schedule_id and organization_id = p_organization_id
  for update;

  if v_schedule.id is null then
    raise exception 'Schedule not found.' using errcode = 'P0002';
  end if;

  if not v_schedule.is_active then
    raise exception 'This schedule is inactive.' using errcode = '22023';
  end if;

  if v_schedule.next_occurrence_index <> p_expected_occurrence_index then
    -- GL020 is a GrowLink-specific application code (not a reserved
    -- Postgres SQLSTATE) — see this file's header comment for why '40001'
    -- must never be used here.
    raise exception 'STALE_OCCURRENCE' using errcode = 'GL020';
  end if;

  insert into public.maintenance_schedule_completions (
    organization_id, schedule_id, schedule_name_snapshot, equipment_id, equipment_name_snapshot, asset_code_snapshot,
    occurrence_index, due_date_snapshot, completion_request_id, completed_by, completed_by_name_snapshot, completed_at,
    meter_reading_value, meter_reading_unit_snapshot, notes, checklist_snapshot, next_due_date_snapshot
  )
  select
    p_organization_id, v_schedule.id, v_schedule.name, e.id, e.name, e.asset_code,
    v_schedule.next_occurrence_index, v_schedule.next_due_date, p_completion_request_id,
    p_completed_by, p_completed_by_name, p_completed_at,
    p_meter_reading_value, p_meter_reading_unit_snapshot, p_notes, p_checklist_snapshot, p_next_due_date
  from public.maintenance_equipment e
  where e.id = v_schedule.equipment_id
  returning * into v_completion;

  update public.maintenance_schedules
  set next_due_date = p_next_due_date,
      next_occurrence_index = p_next_occurrence_index,
      last_completed_at = p_completed_at,
      is_active = case when p_next_due_date is null then false else is_active end,
      updated_at = now()
  where id = p_schedule_id;

  return v_completion;
end;
$$;

create or replace function public.maintenance_confirm_stock_count_session(
  p_organization_id uuid,
  p_session_id uuid,
  p_confirmed_by uuid,
  p_confirmed_by_name text
)
returns public.maintenance_stock_count_sessions
language plpgsql
as $$
declare
  v_session public.maintenance_stock_count_sessions;
  v_line record;
  v_latest uuid;
  v_conflicts jsonb := '[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 10));

  select * into v_session
  from public.maintenance_stock_count_sessions
  where id = p_session_id and organization_id = p_organization_id
  for update;

  if v_session.id is null then
    raise exception 'Stock count session not found.' using errcode = 'P0002';
  end if;

  if v_session.status = 'confirmed' then
    return v_session; -- idempotent replay
  end if;

  if v_session.status = 'cancelled' then
    raise exception 'This stock count session was cancelled.' using errcode = '22023';
  end if;

  for v_line in select * from public.maintenance_stock_count_lines where session_id = p_session_id loop
    if v_line.counted_quantity is null then
      v_conflicts := v_conflicts || jsonb_build_object('line_id', v_line.id, 'reason', 'not_counted');
      continue;
    end if;

    select t.id into v_latest
    from public.maintenance_inventory_transactions t
    where t.item_id = v_line.item_id
    order by t.created_at desc, t.id desc
    limit 1;

    if v_latest is distinct from v_line.expected_last_transaction_id then
      v_conflicts := v_conflicts || jsonb_build_object('line_id', v_line.id, 'reason', 'inventory_changed_since_snapshot');
    end if;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    -- GL021 is a GrowLink-specific application code — see this file's
    -- header comment for why '40001' must never be used here.
    raise exception 'CONFLICT:%', v_conflicts::text using errcode = 'GL021';
  end if;

  for v_line in select * from public.maintenance_stock_count_lines where session_id = p_session_id loop
    if v_line.counted_quantity <> v_line.expected_quantity then
      perform public.maintenance_apply_inventory_transaction(
        p_organization_id, v_line.item_id, 'stock_count_correction', v_line.counted_quantity - v_line.expected_quantity,
        'Stock count session ' || p_session_id, gen_random_uuid(), p_confirmed_by, p_confirmed_by_name,
        null, null, p_session_id, false
      );
    end if;
  end loop;

  update public.maintenance_stock_count_sessions
  set status = 'confirmed', confirmed_at = now(), confirmed_by = p_confirmed_by, updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

create or replace function public.maintenance_receive_restock_line(
  p_organization_id uuid,
  p_request_id uuid,
  p_line_id uuid,
  p_receive_quantity numeric,
  p_ledger_request_id uuid,
  p_performed_by uuid,
  p_performed_by_name text
)
returns table (line public.maintenance_restock_request_lines, request_status text)
language plpgsql
as $$
declare
  v_line public.maintenance_restock_request_lines;
  v_remaining numeric;
  v_existing_txn_id uuid;
  v_request_status text;
  v_all_received boolean;
  v_any_received boolean;
begin
  if p_receive_quantity <= 0 then
    raise exception 'Receive quantity must be greater than zero.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_line_id::text, 11));

  select * into v_line
  from public.maintenance_restock_request_lines
  where id = p_line_id and request_id = p_request_id and organization_id = p_organization_id
  for update;

  if v_line.id is null then
    raise exception 'Restock request line not found.' using errcode = 'P0002';
  end if;

  -- Idempotent replay: this exact ledger request already applied. Checked
  -- BEFORE the remaining-quantity validation below — received_quantity was
  -- already bumped by the original call, so re-validating against it here
  -- would incorrectly reject a legitimate retry as "exceeds what remains."
  select id into v_existing_txn_id
  from public.maintenance_inventory_transactions
  where organization_id = p_organization_id and request_id = p_ledger_request_id;

  if v_existing_txn_id is not null then
    select status into v_request_status from public.maintenance_restock_requests where id = p_request_id;
    return query select v_line, v_request_status;
    return;
  end if;

  v_remaining := v_line.requested_quantity - v_line.received_quantity;

  if p_receive_quantity > v_remaining then
    raise exception 'Cannot receive % — only % remains on this line.', p_receive_quantity, v_remaining
      using errcode = '23514';
  end if;

  perform public.maintenance_apply_inventory_transaction(
    p_organization_id, v_line.item_id, 'restock_receipt', p_receive_quantity,
    'Restock request ' || p_request_id, p_ledger_request_id, p_performed_by, p_performed_by_name,
    p_request_id, p_line_id, null, false
  );

  update public.maintenance_restock_request_lines
  set received_quantity = received_quantity + p_receive_quantity, updated_at = now()
  where id = p_line_id
  returning * into v_line;

  select
    bool_and(received_quantity >= requested_quantity),
    bool_or(received_quantity > 0)
  into v_all_received, v_any_received
  from public.maintenance_restock_request_lines
  where request_id = p_request_id;

  v_request_status := case when v_all_received then 'received' when v_any_received then 'partially_received' else 'requested' end;

  update public.maintenance_restock_requests
  set status = v_request_status,
      completed_at = case when v_request_status = 'received' then now() else completed_at end,
      updated_at = now()
  where id = p_request_id and status not in ('cancelled');

  return query select v_line, v_request_status;
end;
$$;
