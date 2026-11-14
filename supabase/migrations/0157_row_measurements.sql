-- Migration 0157: Dated row measurements (DRAFT for review: not applied anywhere)
--
-- Setup → Map becomes the source of truth for each greenhouse row's real
-- width and length (meters). Measurements are kept as dated versions, so a
-- resize or a new row for a future season never changes what a past or
-- current date reports:
--
--   greenhouse_row_measurements   one version per row and effective date:
--                                 width_m, length_m, effective_from
--
--   * The baseline version (effective_from null = "since the beginning") is
--     copied exactly from Greenhouse Setup by copy_row_measurements_from_setup:
--     the row's own width and length when it has both (keeping per-row
--     differences from its section), else its section's, else recorded as
--     missing (null) and flagged. The map drawing's sizes are never used.
--   * A resize adds a version that applies from a date; earlier dates keep the
--     earlier version. Versions are append-only: a new one must start after
--     the row's latest version.
--   * A new row exists from its first version's date; before that date it
--     isn't in the greenhouse.
--   * row_measurements_on(org, date) answers "what size was each row on date
--     D", for today's reports and historical ones alike.
--
-- Rows keep their ids, phase and row number: versions point at
-- greenhouse_rows.id (on delete restrict, so a measured row can't be deleted
-- and take its history with it). Moving or redrawing a row on the map only
-- changes greenhouse_map_rows; it never touches a measurement.
--
-- Until every reader uses row_measurements_on, greenhouse_rows.width_meters /
-- length_meters stay as a mirror of the version in effect today: a change
-- effective today or earlier updates the mirror, a future change doesn't.
--
-- Adds a table and functions only. Copying the baseline is a separate,
-- reviewed step (it only inserts measurement rows; greenhouse_rows is not
-- changed by the copy).
--
-- Access: service role only (RLS on, no policies), like 0154-0156.

begin;

create table if not exists public.greenhouse_row_measurements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  row_id           uuid not null references public.greenhouse_rows(id) on delete restrict,
  width_m          numeric null check (width_m is null or width_m > 0),
  length_m         numeric null check (length_m is null or length_m > 0),
  effective_from   date null,
  source           text not null check (source in ('greenhouse_setup_row', 'greenhouse_setup_section', 'missing', 'map_resize', 'map_new_row')),
  created_by       uuid null,
  created_at       timestamptz not null default now(),
  -- only the copied baseline may be missing a measurement
  constraint greenhouse_row_measurements_complete check (source = 'missing' or (width_m is not null and length_m is not null)),
  -- only the copied baseline applies "since the beginning"
  constraint greenhouse_row_measurements_baseline check ((effective_from is null) = (source in ('greenhouse_setup_row', 'greenhouse_setup_section', 'missing')))
);

create unique index if not exists greenhouse_row_measurements_row_date_key
  on public.greenhouse_row_measurements (row_id, coalesce(effective_from, '0001-01-01'::date));
create index if not exists greenhouse_row_measurements_org_idx on public.greenhouse_row_measurements (organization_id, row_id);

-- A measurement belongs to a row of its organization; versions are append-only.
create or replace function public.greenhouse_row_measurements_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest date;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Row measurements are history: add a new version instead of changing one' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.greenhouse_rows r where r.id = new.row_id and r.organization_id = new.organization_id) then
    raise exception 'A measurement must be for a row of its organization' using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtext('row_measurements:' || new.row_id::text));
  if new.effective_from is not null then
    select max(effective_from) into v_latest from public.greenhouse_row_measurements where row_id = new.row_id;
    if v_latest is not null and new.effective_from <= v_latest then
      raise exception 'A new size must apply after the row''s latest size (from %)', v_latest using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists greenhouse_row_measurements_check on public.greenhouse_row_measurements;
create trigger greenhouse_row_measurements_check
  before insert or update on public.greenhouse_row_measurements
  for each row execute function public.greenhouse_row_measurements_check();

-- The baseline: one version per row that has none yet, copied exactly from
-- Greenhouse Setup. Safe to run again (rows already measured are skipped).
-- Returns how many rows were copied from the row, from the section, or missing.
create or replace function public.copy_row_measurements_from_setup(p_organization_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_result jsonb;
begin
  with source as (
    select r.id as row_id,
           case when r.width_meters > 0 and r.length_meters > 0 then 'greenhouse_setup_row'
                when s.width_meters > 0 and s.length_meters > 0 then 'greenhouse_setup_section'
                else 'missing' end as source,
           case when r.width_meters > 0 and r.length_meters > 0 then r.width_meters
                when s.width_meters > 0 and s.length_meters > 0 then s.width_meters end as width_m,
           case when r.width_meters > 0 and r.length_meters > 0 then r.length_meters
                when s.width_meters > 0 and s.length_meters > 0 then s.length_meters end as length_m
      from public.greenhouse_rows r
      left join public.greenhouse_row_sections s on s.id = r.section_id and s.organization_id = r.organization_id
     where r.organization_id = p_organization_id
       and not exists (select 1 from public.greenhouse_row_measurements m where m.row_id = r.id)
  ), inserted as (
    insert into public.greenhouse_row_measurements (organization_id, row_id, width_m, length_m, effective_from, source, created_by)
    select p_organization_id, row_id, width_m, length_m, null, source, p_user_id from source
    returning source
  )
  select jsonb_build_object(
    'copied_from_row', count(*) filter (where source = 'greenhouse_setup_row'),
    'copied_from_section', count(*) filter (where source = 'greenhouse_setup_section'),
    'missing', count(*) filter (where source = 'missing')
  ) into v_result from inserted;
  return v_result;
end;
$$;

-- Each row's size on a date: the latest version in effect that day. Rows
-- with no version in effect yet (added for a later date) aren't listed.
create or replace function public.row_measurements_on(p_organization_id uuid, p_date date)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'row_id', v.row_id, 'group_id', r.group_id, 'row_number', r.row_number,
           'width_m', v.width_m, 'length_m', v.length_m, 'effective_from', v.effective_from, 'source', v.source
         ) order by r.group_id, r.row_number), '[]'::jsonb)
    from (
      select distinct on (m.row_id) m.*
        from public.greenhouse_row_measurements m
       where m.organization_id = p_organization_id
         and (m.effective_from is null or m.effective_from <= p_date)
       order by m.row_id, m.effective_from desc nulls last
    ) v
    join public.greenhouse_rows r on r.id = v.row_id;
$$;

-- Resize (Setup → Map): new versions for these rows from p_effective_from, in
-- one transaction. p_rows: [{"row_id": "...", "width_m": 1.6, "length_m": 91.44}].
-- When the change applies today or earlier (p_today, the organization's local
-- date) the greenhouse_rows mirror is updated too; a future change leaves it.
create or replace function public.record_row_measurements(
  p_organization_id uuid,
  p_rows            jsonb,
  p_effective_from  date,
  p_today           date,
  p_user_id         uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.greenhouse_row_measurements (organization_id, row_id, width_m, length_m, effective_from, source, created_by)
  select p_organization_id, (x ->> 'row_id')::uuid, (x ->> 'width_m')::numeric, (x ->> 'length_m')::numeric, p_effective_from, 'map_resize', p_user_id
    from jsonb_array_elements(p_rows) x;
  get diagnostics v_count = row_count;

  if p_effective_from <= p_today then
    update public.greenhouse_rows r
       set width_meters = (x ->> 'width_m')::numeric, length_meters = (x ->> 'length_m')::numeric, updated_at = now()
      from jsonb_array_elements(p_rows) x
     where r.id = (x ->> 'row_id')::uuid and r.organization_id = p_organization_id;
  end if;
  return jsonb_build_object('rows', v_count);
end;
$$;

-- New rows (Setup → Map): greenhouse_rows plus their first measurement from
-- p_effective_from, in one transaction. p_rows: [{"row_number": 773,
-- "width_m": 1.57, "length_m": 73.15, "slab_count": 65, "plants_per_slab": 6,
-- "stems_per_plant": 2}]. The mirror gets the size only when the row exists
-- today or earlier.
create or replace function public.add_measured_rows(
  p_organization_id uuid,
  p_group_id        uuid,
  p_rows            jsonb,
  p_effective_from  date,
  p_today           date,
  p_user_id         uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  if not exists (select 1 from public.greenhouse_groups g where g.id = p_group_id and g.organization_id = p_organization_id) then
    raise exception 'Phase not found' using errcode = 'no_data_found';
  end if;

  with created as (
    insert into public.greenhouse_rows (organization_id, group_id, row_number, slab_count, plants_per_slab, stems_per_plant, width_meters, length_meters)
    select p_organization_id, p_group_id, (x ->> 'row_number')::integer,
           coalesce((x ->> 'slab_count')::integer, 0), coalesce((x ->> 'plants_per_slab')::integer, 0), coalesce((x ->> 'stems_per_plant')::numeric, 1),
           case when p_effective_from <= p_today then (x ->> 'width_m')::numeric end,
           case when p_effective_from <= p_today then (x ->> 'length_m')::numeric end
      from jsonb_array_elements(p_rows) x
    returning id, row_number
  )
  insert into public.greenhouse_row_measurements (organization_id, row_id, width_m, length_m, effective_from, source, created_by)
  select p_organization_id, c.id, (x ->> 'width_m')::numeric, (x ->> 'length_m')::numeric, p_effective_from, 'map_new_row', p_user_id
    from created c join jsonb_array_elements(p_rows) x on (x ->> 'row_number')::integer = c.row_number;
  get diagnostics v_count = row_count;
  return jsonb_build_object('rows', v_count);
end;
$$;

revoke all on function public.greenhouse_row_measurements_check() from anon, authenticated, public;
revoke all on function public.copy_row_measurements_from_setup(uuid, uuid) from anon, authenticated, public;
revoke all on function public.row_measurements_on(uuid, date) from anon, authenticated, public;
revoke all on function public.record_row_measurements(uuid, jsonb, date, date, uuid) from anon, authenticated, public;
revoke all on function public.add_measured_rows(uuid, uuid, jsonb, date, date, uuid) from anon, authenticated, public;
grant execute on function public.copy_row_measurements_from_setup(uuid, uuid) to service_role;
grant execute on function public.row_measurements_on(uuid, date) to service_role;
grant execute on function public.record_row_measurements(uuid, jsonb, date, date, uuid) to service_role;
grant execute on function public.add_measured_rows(uuid, uuid, jsonb, date, date, uuid) to service_role;

alter table public.greenhouse_row_measurements enable row level security;
revoke all on table public.greenhouse_row_measurements from anon, authenticated, public;
grant select, insert, update, delete on table public.greenhouse_row_measurements to service_role;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.greenhouse_row_measurements'::regclass) then
    raise exception '0157 aborted: row level security is off on public.greenhouse_row_measurements';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'greenhouse_row_measurements') then
    raise exception '0157 aborted: unexpected policy on public.greenhouse_row_measurements';
  end if;
end $$;

commit;

-- ROLLBACK (drops every measurement version; greenhouse_rows keeps its mirrored values):
-- begin;
-- drop function if exists public.add_measured_rows(uuid, uuid, jsonb, date, date, uuid);
-- drop function if exists public.record_row_measurements(uuid, jsonb, date, date, uuid);
-- drop function if exists public.row_measurements_on(uuid, date);
-- drop function if exists public.copy_row_measurements_from_setup(uuid, uuid);
-- drop table if exists public.greenhouse_row_measurements;
-- drop function if exists public.greenhouse_row_measurements_check();
-- commit;
