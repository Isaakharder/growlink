-- Maintenance module — equipment work logs.
--
-- Replaces the mobile client's old "Record Reading" action (a bare meter
-- value + optional note) with a proper work-log record: what was done,
-- optionally paired with a meter reading, notes, and a user-adjustable
-- performed-at timestamp. The old maintenance_record_meter_reading RPC
-- (0128) and its endpoint are untouched — this is purely additive, and a
-- manual-reading-only path still exists at the DB/API layer even though
-- the mobile UI now drives everything through the work-log flow.
--
-- Atomicity: when a work log includes a meter reading,
-- maintenance_log_equipment_work below inserts the meter reading row,
-- updates the equipment's cached current_meter_reading, and inserts the
-- work log row all inside the same plpgsql function call — a single
-- implicit transaction, so a failure at any point (e.g. the reading is
-- lower than the current one) rolls back everything, never leaving a
-- meter reading without its work log or vice versa.
--
-- No-duplicate-history: a work log's own meter reading is inserted into
-- maintenance_meter_readings (the same ledger manual readings use, so
-- current_meter_reading derives from one place) but tagged via the new
-- related_work_log_id column. The equipment history endpoint excludes any
-- meter reading with related_work_log_id set, since that reading is
-- already represented by its parent work log entry — manual/legacy
-- readings (related_work_log_id null) are unaffected and remain visible.

-- ============================================================
-- maintenance_work_logs
-- ============================================================

create table public.maintenance_work_logs (
  id                          uuid           primary key default gen_random_uuid(),
  organization_id             uuid           not null references public.organizations(id) on delete cascade,
  equipment_id                uuid           references public.maintenance_equipment(id) on delete set null,
  equipment_name_snapshot     text           not null,
  asset_code_snapshot         text           not null,
  work_performed              text           not null check (length(trim(work_performed)) > 0),
  meter_reading_value         numeric(14, 2) check (meter_reading_value is null or meter_reading_value >= 0),
  meter_reading_unit_snapshot text,
  notes                       text,
  performed_at                timestamptz    not null default now(),
  performed_by                uuid           references auth.users(id) on delete set null,
  performed_by_name_snapshot  text           not null,
  -- Idempotency key (client-generated crypto.randomUUID(), same pattern as
  -- maintenance_schedule_completions.completion_request_id) so a retried
  -- "Save Job" tap — the double-tap case, or a network retry after an
  -- ambiguous response — can never create a second work log.
  request_id                  uuid           not null,
  created_at                  timestamptz    not null default now(),
  constraint maintenance_work_logs_org_request_unique unique (organization_id, request_id),
  constraint maintenance_work_logs_reading_unit_check check (
    (meter_reading_value is null and meter_reading_unit_snapshot is null)
    or (meter_reading_value is not null and meter_reading_unit_snapshot is not null)
  )
);

create index maintenance_work_logs_equipment_idx
  on public.maintenance_work_logs (equipment_id, performed_at desc, id desc);
create index maintenance_work_logs_org_idx
  on public.maintenance_work_logs (organization_id, performed_at desc);

alter table public.maintenance_work_logs enable row level security;

create policy maintenance_work_logs_select_org on public.maintenance_work_logs
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_work_logs_insert_org on public.maintenance_work_logs
  for insert to authenticated with check (public.is_org_member(organization_id));

-- No update/delete policy or grant — work logs are immutable, same as
-- maintenance_meter_readings and maintenance_schedule_completions.
grant select, insert on table public.maintenance_work_logs to service_role;

create trigger maintenance_work_logs_immutable
  before update or delete on public.maintenance_work_logs
  for each row execute function public.maintenance_prevent_mutation();

-- ============================================================
-- Link a work-log-originated meter reading back to its work log, so the
-- merged equipment history can exclude it (the work log entry already
-- shows the reading inline) without touching or losing any existing rows.
-- ============================================================

alter table public.maintenance_meter_readings
  add column related_work_log_id uuid references public.maintenance_work_logs(id) on delete set null;

create index maintenance_meter_readings_related_work_log_idx
  on public.maintenance_meter_readings (related_work_log_id)
  where related_work_log_id is not null;

-- ============================================================
-- maintenance_log_equipment_work
-- ============================================================

create function public.maintenance_log_equipment_work(
  p_organization_id uuid,
  p_equipment_id uuid,
  p_request_id uuid,
  p_work_performed text,
  p_meter_reading_value numeric,
  p_notes text,
  p_performed_at timestamptz,
  p_performed_by uuid,
  p_performed_by_name text
)
returns public.maintenance_work_logs
language plpgsql
as $$
declare
  v_equipment public.maintenance_equipment;
  v_log public.maintenance_work_logs;
  v_reading_id uuid;
  v_unit text;
begin
  select * into v_log
  from public.maintenance_work_logs
  where organization_id = p_organization_id and request_id = p_request_id;

  if v_log.id is not null then
    return v_log; -- idempotent replay
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_equipment_id::text, 8));

  select * into v_equipment
  from public.maintenance_equipment
  where id = p_equipment_id and organization_id = p_organization_id
  for update;

  if v_equipment.id is null then
    raise exception 'Equipment not found.' using errcode = 'P0002';
  end if;

  if p_work_performed is null or length(trim(p_work_performed)) = 0 then
    raise exception 'Work performed is required.' using errcode = '22023';
  end if;

  if p_meter_reading_value is not null then
    if p_meter_reading_value < 0 then
      raise exception 'Meter reading cannot be negative.' using errcode = '22023';
    end if;

    if v_equipment.current_meter_reading is not null and p_meter_reading_value < v_equipment.current_meter_reading then
      raise exception 'New reading (%) is lower than the current reading (%).',
        p_meter_reading_value, v_equipment.current_meter_reading using errcode = '22023';
    end if;

    v_unit := coalesce(v_equipment.meter_unit_custom_label, v_equipment.meter_unit);
  end if;

  insert into public.maintenance_work_logs (
    organization_id, equipment_id, equipment_name_snapshot, asset_code_snapshot,
    work_performed, meter_reading_value, meter_reading_unit_snapshot, notes,
    performed_at, performed_by, performed_by_name_snapshot, request_id
  ) values (
    p_organization_id, p_equipment_id, v_equipment.name, v_equipment.asset_code,
    trim(p_work_performed), p_meter_reading_value, v_unit, p_notes,
    coalesce(p_performed_at, now()), p_performed_by, p_performed_by_name, p_request_id
  )
  returning * into v_log;

  if p_meter_reading_value is not null then
    insert into public.maintenance_meter_readings (
      organization_id, equipment_id, equipment_name_snapshot, asset_code_snapshot,
      value, unit_snapshot, recorded_at, note, is_reset, reset_reason,
      recorded_by, recorded_by_name_snapshot, related_work_log_id
    ) values (
      p_organization_id, p_equipment_id, v_equipment.name, v_equipment.asset_code,
      p_meter_reading_value, v_unit, v_log.performed_at, trim(p_work_performed), false, null,
      p_performed_by, p_performed_by_name, v_log.id
    )
    returning id into v_reading_id;

    update public.maintenance_equipment
    set current_meter_reading = p_meter_reading_value,
        current_meter_reading_at = v_log.performed_at,
        updated_at = now(),
        updated_by = p_performed_by
    where id = p_equipment_id;
  end if;

  return v_log;
end;
$$;

revoke execute on function public.maintenance_log_equipment_work(
  uuid, uuid, uuid, text, numeric, text, timestamptz, uuid, text
) from public;
grant execute on function public.maintenance_log_equipment_work(
  uuid, uuid, uuid, text, numeric, text, timestamptz, uuid, text
) to service_role;
