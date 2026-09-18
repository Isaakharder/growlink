-- Maintenance module — Equipment, meter readings, and scheduled maintenance.
--
-- maintenance_equipment holds one row per tracked asset (mower, sprayer,
-- boiler, vehicle, etc.), referencing the Setup tables from 0127. Each piece
-- of equipment carries an opaque QR token (see qr_token below) and a cached
-- "current meter reading" that maintenance_record_meter_reading keeps in
-- sync atomically.
--
-- Scheduled maintenance is calendar/interval-based only in v1 (no
-- meter-triggered schedules yet — meter readings are informational only,
-- per the product spec). A schedule's "which occurrence is currently due"
-- is tracked entirely server-side via next_due_date/next_occurrence_index
-- on the schedule row itself (row-locked on completion) — the client never
-- supplies an occurrence identity, which removes a whole class of
-- client-trust bugs and sidesteps any ambiguity from a schedule being
-- edited mid-cycle. The actual due-date recurrence math (anchored, not
-- drifting; month-end/leap-year safe) lives in TypeScript
-- (server/src/routes/maintenance/services/dueDateCalc.ts), matching this
-- repo's existing convention (see pestCalibration/services/dueScheduling.ts)
-- of computing dates in the application layer and only ever storing
-- already-computed values via the RPC below.

-- ============================================================
-- maintenance_equipment
-- ============================================================
--
-- qr_token is a plaintext, opaque, non-sequential uuid — a deliberate
-- departure from organization_invites.token_hash (0042), which stores only
-- a hash because an invite token is a bearer credential that grants account
-- access on its own. A scanned equipment QR token only ever *identifies* a
-- row to an already-authenticated, already-org-scoped user (see qr.ts's
-- lookup, which always filters by organization_id in the same query) — it
-- never grants any access beyond what that user's normal permissions
-- already allow. Storing it in plaintext is also required by the "view/
-- download the code later" requirement: the same QR image must be
-- re-renderable on demand without forcing a regeneration, which a
-- hash-only column could never support.

create table public.maintenance_equipment (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete cascade,
  name                      text        not null,
  asset_code                text        not null,
  asset_code_normalized     text        generated always as (lower(trim(asset_code))) stored,
  category_id               uuid        not null references public.maintenance_categories(id) on delete restrict,
  location_id               uuid        not null references public.maintenance_locations(id) on delete restrict,
  status                    text        not null default 'active' check (status in ('active', 'out_of_service', 'retired')),
  make                      text,
  model                     text,
  serial_number             text,
  description               text,
  meter_unit                text        not null default 'hours' check (meter_unit in ('hours', 'km', 'cycles', 'custom')),
  meter_unit_custom_label   text,
  qr_token                  uuid        not null default gen_random_uuid(),
  qr_token_created_at       timestamptz not null default now(),
  current_meter_reading     numeric(14, 2),
  current_meter_reading_at  timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid        references auth.users(id) on delete set null,
  updated_by                uuid        references auth.users(id) on delete set null,
  constraint maintenance_equipment_org_asset_code_unique unique (organization_id, asset_code_normalized),
  constraint maintenance_equipment_qr_token_unique unique (qr_token),
  constraint maintenance_equipment_meter_unit_custom_check check (
    (meter_unit = 'custom' and meter_unit_custom_label is not null and length(trim(meter_unit_custom_label)) > 0)
    or (meter_unit <> 'custom' and meter_unit_custom_label is null)
  )
);

create index maintenance_equipment_org_status_idx on public.maintenance_equipment (organization_id, status);
create index maintenance_equipment_org_category_idx on public.maintenance_equipment (organization_id, category_id);
create index maintenance_equipment_org_location_idx on public.maintenance_equipment (organization_id, location_id);

alter table public.maintenance_equipment enable row level security;

create policy maintenance_equipment_select_org on public.maintenance_equipment
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_equipment_insert_org on public.maintenance_equipment
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_equipment_update_org on public.maintenance_equipment
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_equipment_delete_org on public.maintenance_equipment
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_equipment to service_role;

-- ============================================================
-- maintenance_meter_readings (immutable)
-- ============================================================

create table public.maintenance_meter_readings (
  id                          uuid          primary key default gen_random_uuid(),
  organization_id             uuid          not null references public.organizations(id) on delete cascade,
  equipment_id                uuid          references public.maintenance_equipment(id) on delete set null,
  equipment_name_snapshot     text          not null,
  asset_code_snapshot         text          not null,
  value                       numeric(14, 2) not null check (value >= 0),
  unit_snapshot               text          not null,
  recorded_at                 timestamptz   not null default now(),
  recorded_by                 uuid          references auth.users(id) on delete set null,
  recorded_by_name_snapshot   text          not null,
  note                        text,
  is_reset                    boolean       not null default false,
  reset_reason                text,
  created_at                  timestamptz   not null default now(),
  constraint maintenance_meter_readings_reset_reason_check check (
    (is_reset and reset_reason is not null and length(trim(reset_reason)) > 0)
    or (not is_reset and reset_reason is null)
  )
);

create index maintenance_meter_readings_equipment_idx
  on public.maintenance_meter_readings (equipment_id, recorded_at desc, id desc);
create index maintenance_meter_readings_org_idx
  on public.maintenance_meter_readings (organization_id, recorded_at desc);

alter table public.maintenance_meter_readings enable row level security;

create policy maintenance_meter_readings_select_org on public.maintenance_meter_readings
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_meter_readings_insert_org on public.maintenance_meter_readings
  for insert to authenticated with check (public.is_org_member(organization_id));

-- No update/delete policy or grant — the trigger below is the real
-- guarantee, this is belt-and-suspenders (same pattern as
-- pest_calibration_records).
grant select, insert on table public.maintenance_meter_readings to service_role;

create trigger maintenance_meter_readings_immutable
  before update or delete on public.maintenance_meter_readings
  for each row execute function public.maintenance_prevent_mutation();

-- maintenance_record_meter_reading: the only way a meter reading is ever
-- recorded. Locks the equipment row (advisory lock keyed by equipment id,
-- then a blocking FOR UPDATE on the row — same combination used by
-- food_safety_set_checklist_item_response, 0089) so two concurrent
-- submissions can't both race past the "lower than latest" check, inserts
-- the immutable reading, and updates the equipment's cached current
-- reading — all in one transaction.
create function public.maintenance_record_meter_reading(
  p_organization_id uuid,
  p_equipment_id uuid,
  p_value numeric,
  p_note text,
  p_is_reset boolean,
  p_reset_reason text,
  p_recorded_by uuid,
  p_recorded_by_name text
)
returns public.maintenance_meter_readings
language plpgsql
as $$
declare
  v_equipment public.maintenance_equipment;
  v_reading public.maintenance_meter_readings;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_equipment_id::text, 8));

  select * into v_equipment
  from public.maintenance_equipment
  where id = p_equipment_id and organization_id = p_organization_id
  for update;

  if v_equipment.id is null then
    raise exception 'Equipment not found.' using errcode = 'P0002';
  end if;

  if p_value < 0 then
    raise exception 'Meter reading cannot be negative.' using errcode = '22023';
  end if;

  if not p_is_reset and v_equipment.current_meter_reading is not null and p_value < v_equipment.current_meter_reading then
    raise exception 'New reading (%) is lower than the current reading (%). Use a meter reset if the meter was replaced or rolled over.',
      p_value, v_equipment.current_meter_reading using errcode = '22023';
  end if;

  if p_is_reset and (p_reset_reason is null or length(trim(p_reset_reason)) = 0) then
    raise exception 'A reason is required when resetting a meter.' using errcode = '22023';
  end if;

  insert into public.maintenance_meter_readings (
    organization_id, equipment_id, equipment_name_snapshot, asset_code_snapshot,
    value, unit_snapshot, note, is_reset, reset_reason, recorded_by, recorded_by_name_snapshot
  ) values (
    p_organization_id, p_equipment_id, v_equipment.name, v_equipment.asset_code,
    p_value, coalesce(v_equipment.meter_unit_custom_label, v_equipment.meter_unit),
    p_note, p_is_reset, p_reset_reason, p_recorded_by, p_recorded_by_name
  )
  returning * into v_reading;

  update public.maintenance_equipment
  set current_meter_reading = p_value,
      current_meter_reading_at = v_reading.recorded_at,
      updated_at = now(),
      updated_by = p_recorded_by
  where id = p_equipment_id;

  return v_reading;
end;
$$;

revoke execute on function public.maintenance_record_meter_reading(uuid, uuid, numeric, text, boolean, text, uuid, text) from public;
grant execute on function public.maintenance_record_meter_reading(uuid, uuid, numeric, text, boolean, text, uuid, text) to service_role;

-- ============================================================
-- maintenance_schedules
-- ============================================================

create table public.maintenance_schedules (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete cascade,
  equipment_id              uuid        not null references public.maintenance_equipment(id) on delete cascade,
  name                      text        not null,
  instructions              text,
  first_due_date            date        not null,
  recurrence_type           text        not null check (recurrence_type in ('one_time', 'daily', 'weekly', 'monthly', 'yearly')),
  recurrence_interval       integer     not null default 1 check (recurrence_interval > 0),
  warning_days_before_due   integer     not null default 0 check (warning_days_before_due >= 0),
  is_active                 boolean     not null default true,
  -- Initialized by the route handler to (first_due_date, 0) on insert — not
  -- a column default, since it must copy another column's value. The sole
  -- source of truth for "which occurrence is currently pending"; the
  -- completion RPC always completes whichever occurrence the schedule is
  -- currently sitting on, under a row lock, never an occurrence the client
  -- names itself.
  next_due_date             date,
  next_occurrence_index     integer     not null default 0,
  last_completed_at         timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid        references auth.users(id) on delete set null,
  updated_by                uuid        references auth.users(id) on delete set null,
  constraint maintenance_schedules_one_time_interval_check check (recurrence_type <> 'one_time' or recurrence_interval = 1)
);

create index maintenance_schedules_org_active_due_idx
  on public.maintenance_schedules (organization_id, is_active, next_due_date);
create index maintenance_schedules_equipment_idx on public.maintenance_schedules (equipment_id);

alter table public.maintenance_schedules enable row level security;

create policy maintenance_schedules_select_org on public.maintenance_schedules
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_schedules_insert_org on public.maintenance_schedules
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_schedules_update_org on public.maintenance_schedules
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_schedules_delete_org on public.maintenance_schedules
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_schedules to service_role;

-- ============================================================
-- maintenance_schedule_checklist_items
-- ============================================================

create table public.maintenance_schedule_checklist_items (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  schedule_id       uuid        not null references public.maintenance_schedules(id) on delete cascade,
  label             text        not null,
  sort_order        integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index maintenance_schedule_checklist_items_schedule_idx
  on public.maintenance_schedule_checklist_items (schedule_id, sort_order);

alter table public.maintenance_schedule_checklist_items enable row level security;

create policy maintenance_schedule_checklist_items_select_org on public.maintenance_schedule_checklist_items
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_schedule_checklist_items_insert_org on public.maintenance_schedule_checklist_items
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_schedule_checklist_items_update_org on public.maintenance_schedule_checklist_items
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_schedule_checklist_items_delete_org on public.maintenance_schedule_checklist_items
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_schedule_checklist_items to service_role;

-- ============================================================
-- maintenance_schedule_completions (immutable)
-- ============================================================

create table public.maintenance_schedule_completions (
  id                              uuid        primary key default gen_random_uuid(),
  organization_id                 uuid        not null references public.organizations(id) on delete cascade,
  schedule_id                     uuid        references public.maintenance_schedules(id) on delete set null,
  schedule_name_snapshot          text        not null,
  equipment_id                    uuid        references public.maintenance_equipment(id) on delete set null,
  equipment_name_snapshot         text        not null,
  asset_code_snapshot             text        not null,
  occurrence_index                integer     not null,
  due_date_snapshot                date        not null,
  -- Client-generated (crypto.randomUUID()), resent unchanged on any retry of
  -- the same completion attempt — same idempotent-replay pattern as
  -- pest_calibration_records.completion_request_id (0103/0104).
  completion_request_id           uuid        not null,
  completed_by                    uuid        references auth.users(id) on delete set null,
  completed_by_name_snapshot      text        not null,
  completed_at                    timestamptz not null default now(),
  meter_reading_value             numeric(14, 2),
  meter_reading_unit_snapshot     text,
  notes                           text,
  checklist_snapshot              jsonb       not null default '[]'::jsonb,
  next_due_date_snapshot          date,
  created_at                      timestamptz not null default now(),
  constraint maintenance_schedule_completions_org_request_unique unique (organization_id, completion_request_id),
  -- Hard DB-level guarantee against double-completing the same due
  -- occurrence, independent of the request-id idempotency above.
  constraint maintenance_schedule_completions_org_schedule_occurrence_unique unique (organization_id, schedule_id, occurrence_index)
);

create index maintenance_schedule_completions_schedule_idx
  on public.maintenance_schedule_completions (schedule_id, completed_at desc);
create index maintenance_schedule_completions_equipment_idx
  on public.maintenance_schedule_completions (equipment_id, completed_at desc);

alter table public.maintenance_schedule_completions enable row level security;

create policy maintenance_schedule_completions_select_org on public.maintenance_schedule_completions
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_schedule_completions_insert_org on public.maintenance_schedule_completions
  for insert to authenticated with check (public.is_org_member(organization_id));

grant select, insert on table public.maintenance_schedule_completions to service_role;

create trigger maintenance_schedule_completions_immutable
  before update or delete on public.maintenance_schedule_completions
  for each row execute function public.maintenance_prevent_mutation();

-- maintenance_complete_schedule: the only way a scheduled-maintenance
-- occurrence is ever completed. The route handler computes
-- p_next_occurrence_index/p_next_due_date in TypeScript (dueDateCalc.ts)
-- BEFORE calling this function, having read the schedule's current
-- next_occurrence_index as p_expected_occurrence_index. This function then
-- re-checks that expectation under a row lock: if another request completed
-- the same schedule in between (a genuine race), it raises a distinguishable
-- error (SQLSTATE 40001, serialization_failure) that the route handler
-- catches to re-fetch the schedule, recompute in TS, and retry once
-- automatically — invisible to the end user in the overwhelmingly common
-- non-racing case.
create function public.maintenance_complete_schedule(
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
    raise exception 'STALE_OCCURRENCE' using errcode = '40001';
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
      -- A one-time schedule (p_next_due_date null) auto-deactivates once its
      -- single occurrence is completed.
      is_active = case when p_next_due_date is null then false else is_active end,
      updated_at = now()
  where id = p_schedule_id;

  return v_completion;
end;
$$;

revoke execute on function public.maintenance_complete_schedule(
  uuid, uuid, uuid, integer, integer, date, uuid, text, timestamptz, numeric, text, text, jsonb
) from public;
grant execute on function public.maintenance_complete_schedule(
  uuid, uuid, uuid, integer, integer, date, uuid, text, timestamptz, numeric, text, text, jsonb
) to service_role;
