-- Fixes the amendment status transition introduced in migration 0077.
--
-- food_safety_amend_record previously set the record's canonical status to
-- 'amended' after any amendment. Per the Phase 3 requirement, an amendment
-- must invalidate any prior verification and return the record to
-- "submitted/awaiting verification" — not to a separate resting status.
-- 'amended' is kept as an allowed value in food_safety_records' status
-- CHECK constraint (harmless, forward-compatible) but is no longer produced
-- by this function. The audit event_type remains 'amended' — that log
-- records the ACTION taken, which is unaffected by this fix; only the
-- record's resulting status and the revision's status_snapshot change.
--
-- This corrects the same function created in 0077; it is not safe to edit
-- an already-applied migration file in place, so the fix is applied via
-- CREATE OR REPLACE FUNCTION in this new, additive migration instead.

create or replace function public.food_safety_amend_record(
  p_organization_id uuid,
  p_record_id uuid,
  p_answers_json jsonb,
  p_amended_by_employee_id uuid,
  p_amended_by_user_id uuid,
  p_reason text,
  p_changes jsonb,
  p_metadata_snapshot jsonb
)
returns public.food_safety_records
language plpgsql
as $$
declare
  v_record public.food_safety_records;
  v_schema_json jsonb;
  v_next_revision integer;
  v_prev_revision integer;
  v_now timestamptz := now();
  v_change jsonb;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'An amendment reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_record_id::text, 1));

  select * into v_record from public.food_safety_records
  where id = p_record_id and organization_id = p_organization_id
  for update;

  if v_record.id is null then
    raise exception 'Record % not found in organization %', p_record_id, p_organization_id using errcode = 'P0002';
  end if;

  if v_record.status not in ('submitted', 'verified', 'amended') then
    raise exception 'Only a submitted, verified, or previously amended record can be amended';
  end if;

  select schema_json into v_schema_json
  from public.food_safety_form_template_versions where id = v_record.template_version_id;

  v_prev_revision := v_record.current_revision_number;
  v_next_revision := v_prev_revision + 1;

  insert into public.food_safety_record_audit_events (
    organization_id, record_id, event_type, actor_user_id, actor_employee_id, event_metadata
  ) values (
    p_organization_id, p_record_id, 'amendment_started', p_amended_by_user_id, p_amended_by_employee_id,
    jsonb_build_object('from_revision_number', v_prev_revision)
  );

  -- Invalidates any prior verification unconditionally, regardless of the
  -- record's status before this call, and returns the record to
  -- 'submitted' (awaiting verification) rather than a separate 'amended'
  -- resting status — a verified record must never keep its old
  -- verification after its answers change underneath it.
  update public.food_safety_records
  set answers_json = p_answers_json,
      status = 'submitted',
      verified_at = null,
      verified_by_employee_id = null,
      verified_by_user_id = null,
      current_revision_number = v_next_revision,
      updated_at = v_now
  where id = p_record_id
  returning * into v_record;

  insert into public.food_safety_record_revisions (
    organization_id, record_id, revision_number, status_snapshot,
    answers_snapshot, template_schema_snapshot, metadata_snapshot, reason,
    created_by_user_id, created_by_employee_id
  ) values (
    p_organization_id, p_record_id, v_next_revision, 'submitted',
    p_answers_json, v_schema_json, p_metadata_snapshot, p_reason,
    p_amended_by_user_id, p_amended_by_employee_id
  );

  -- event_type stays 'amended' — this records the ACTION (an amendment
  -- happened), independent of the resulting record status.
  insert into public.food_safety_record_audit_events (
    organization_id, record_id, event_type, actor_user_id, actor_employee_id, event_metadata
  ) values (
    p_organization_id, p_record_id, 'amended', p_amended_by_user_id, p_amended_by_employee_id,
    jsonb_build_object('revision_number', v_next_revision, 'reason', p_reason)
  );

  if p_changes is not null then
    for v_change in select * from jsonb_array_elements(p_changes)
    loop
      insert into public.food_safety_record_changes (
        organization_id, record_id, from_revision_number, to_revision_number,
        field_id, old_value, new_value, change_reason, changed_by_user_id, changed_by_employee_id
      ) values (
        p_organization_id, p_record_id, v_prev_revision, v_next_revision,
        v_change ->> 'field_id', v_change -> 'old_value', v_change -> 'new_value',
        p_reason, p_amended_by_user_id, p_amended_by_employee_id
      );
    end loop;
  end if;

  return v_record;
end;
$$;
