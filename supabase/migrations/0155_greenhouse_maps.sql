-- Migration 0155: Greenhouse maps
--
-- A drawn map of an organization's greenhouse, used by the Crop Planner to
-- select rows by clicking them. The map is built in GrowLink (or imported
-- from a LabourLink layout file) and stored here, so the planner never
-- depends on LabourLink.
--
--   greenhouse_maps         one map per organization: the land's size in feet
--   greenhouse_map_phases   where each Greenhouse Setup group sits on the map
--   greenhouse_map_rows     where each Greenhouse Setup row sits in its phase
--
-- Coordinates follow LabourLink's map: feet, x eastward from the west edge,
-- y southward from the north edge. A phase is placed on the land; a row is
-- placed relative to its own phase's north-west corner.
--
-- A map row points at a Greenhouse Setup row by group and row number, as the
-- Crop Planner does (0154), so the map survives rows being regenerated from
-- their sections. The server checks that every row exists when a map is
-- saved. The map is drawing only: nothing here reads or writes
-- greenhouse_rows, greenhouse_variety_assignments or any plan.
--
-- Saving replaces the whole map in one transaction (save_greenhouse_map),
-- refused if someone else saved since the map was loaded.
--
-- Access: service role only (RLS on, no policies), like 0154. The server
-- checks the organization on every request.
--
-- Adds tables and a function only; no existing row is changed. Safe to run again.

begin;

create table if not exists public.greenhouse_maps (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  name              text not null check (length(trim(name)) between 1 and 120),
  east_west_feet    numeric not null check (east_west_feet > 0 and east_west_feet <= 100000),
  north_south_feet  numeric not null check (north_south_feet > 0 and north_south_feet <= 100000),
  source            text not null default 'builder' check (source in ('builder', 'labourlink_import')),
  created_by        uuid null,
  updated_by        uuid null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint greenhouse_maps_org_key unique (organization_id),
  constraint greenhouse_maps_id_org_key unique (id, organization_id)
);

create table if not exists public.greenhouse_map_phases (
  id                 uuid primary key default gen_random_uuid(),
  map_id             uuid not null,
  organization_id    uuid not null,
  group_id           uuid not null references public.greenhouse_groups(id) on delete cascade,
  x_feet_from_west   numeric not null check (x_feet_from_west >= 0),
  y_feet_from_north  numeric not null check (y_feet_from_north >= 0),
  east_west_feet     numeric not null check (east_west_feet > 0),
  north_south_feet   numeric not null check (north_south_feet > 0),
  sort_order         integer null,
  created_at         timestamptz not null default now(),
  constraint greenhouse_map_phases_map_fkey foreign key (map_id, organization_id)
    references public.greenhouse_maps(id, organization_id) on delete cascade,
  constraint greenhouse_map_phases_map_group_key unique (map_id, group_id)
);

create table if not exists public.greenhouse_map_rows (
  id               uuid primary key default gen_random_uuid(),
  map_id           uuid not null,
  organization_id  uuid not null,
  group_id         uuid not null,
  row_number       integer not null check (row_number >= 1),
  x_ft             numeric not null check (x_ft >= 0),
  y_ft             numeric not null check (y_ft >= 0),
  width_ft         numeric not null check (width_ft > 0),
  length_ft        numeric not null check (length_ft > 0),
  orientation      text not null check (orientation in ('horizontal', 'vertical')),
  created_at       timestamptz not null default now(),
  constraint greenhouse_map_rows_phase_fkey foreign key (map_id, group_id)
    references public.greenhouse_map_phases(map_id, group_id) on delete cascade,
  constraint greenhouse_map_rows_map_fkey foreign key (map_id, organization_id)
    references public.greenhouse_maps(id, organization_id) on delete cascade,
  -- one position per Greenhouse Setup row
  constraint greenhouse_map_rows_map_row_key unique (map_id, group_id, row_number)
);

create index if not exists greenhouse_map_rows_map_idx on public.greenhouse_map_rows (map_id);

-- A map's phases belong to the map's organization.
create or replace function public.greenhouse_map_phase_matches_organization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.greenhouse_groups g where g.id = new.group_id and g.organization_id = new.organization_id
  ) then
    raise exception 'A map phase must be a greenhouse group of the map''s organization'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists greenhouse_map_phases_match_org on public.greenhouse_map_phases;
create trigger greenhouse_map_phases_match_org
  before insert or update on public.greenhouse_map_phases
  for each row execute function public.greenhouse_map_phase_matches_organization();

-- Replaces an organization's whole map in one transaction. p_expected_updated_at
-- is the updated_at the editor loaded (null when it loaded no map); a save over
-- a newer map is refused with 40001 so nobody's edits are lost silently.
-- The server validates geometry and rows before calling this.
create or replace function public.save_greenhouse_map(
  p_organization_id     uuid,
  p_map                 jsonb,
  p_user_id             uuid,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_map public.greenhouse_maps%rowtype;
  -- milliseconds, so the value survives a round trip through JSON and back
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_phase jsonb;
  v_row jsonb;
begin
  select * into v_map from public.greenhouse_maps where organization_id = p_organization_id for update;

  if found and (p_expected_updated_at is null or v_map.updated_at <> p_expected_updated_at) then
    raise exception 'The map was changed by another save. Reload it and try again.' using errcode = '40001';
  end if;
  if not found and p_expected_updated_at is not null then
    raise exception 'The map was deleted by another save. Reload it and try again.' using errcode = '40001';
  end if;

  if found then
    update public.greenhouse_maps
       set name = p_map ->> 'name',
           east_west_feet = (p_map ->> 'east_west_feet')::numeric,
           north_south_feet = (p_map ->> 'north_south_feet')::numeric,
           source = coalesce(p_map ->> 'source', 'builder'),
           updated_by = p_user_id,
           updated_at = v_now
     where id = v_map.id
     returning * into v_map;
    delete from public.greenhouse_map_phases where map_id = v_map.id; -- rows cascade
  else
    insert into public.greenhouse_maps (organization_id, name, east_west_feet, north_south_feet, source, created_by, updated_by, created_at, updated_at)
    values (p_organization_id, p_map ->> 'name', (p_map ->> 'east_west_feet')::numeric, (p_map ->> 'north_south_feet')::numeric,
            coalesce(p_map ->> 'source', 'builder'), p_user_id, p_user_id, v_now, v_now)
    returning * into v_map;
  end if;

  for v_phase in select * from jsonb_array_elements(coalesce(p_map -> 'phases', '[]'::jsonb)) loop
    insert into public.greenhouse_map_phases (map_id, organization_id, group_id, x_feet_from_west, y_feet_from_north, east_west_feet, north_south_feet, sort_order)
    values (v_map.id, p_organization_id, (v_phase ->> 'group_id')::uuid,
            (v_phase ->> 'x_feet_from_west')::numeric, (v_phase ->> 'y_feet_from_north')::numeric,
            (v_phase ->> 'east_west_feet')::numeric, (v_phase ->> 'north_south_feet')::numeric,
            (v_phase ->> 'sort_order')::integer);
    insert into public.greenhouse_map_rows (map_id, organization_id, group_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
    select v_map.id, p_organization_id, (v_phase ->> 'group_id')::uuid,
           (r ->> 'row_number')::integer, (r ->> 'x_ft')::numeric, (r ->> 'y_ft')::numeric,
           (r ->> 'width_ft')::numeric, (r ->> 'length_ft')::numeric, r ->> 'orientation'
      from jsonb_array_elements(coalesce(v_phase -> 'rows', '[]'::jsonb)) r;
  end loop;

  return jsonb_build_object('id', v_map.id, 'updated_at', v_map.updated_at);
end;
$$;

revoke all on function public.greenhouse_map_phase_matches_organization() from anon, authenticated, public;
revoke all on function public.save_greenhouse_map(uuid, jsonb, uuid, timestamptz) from anon, authenticated, public;
grant execute on function public.save_greenhouse_map(uuid, jsonb, uuid, timestamptz) to service_role;

alter table public.greenhouse_maps enable row level security;
alter table public.greenhouse_map_phases enable row level security;
alter table public.greenhouse_map_rows enable row level security;

revoke all on table public.greenhouse_maps, public.greenhouse_map_phases, public.greenhouse_map_rows
  from anon, authenticated, public;
grant select, insert, update, delete on table public.greenhouse_maps, public.greenhouse_map_phases, public.greenhouse_map_rows
  to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['greenhouse_maps', 'greenhouse_map_phases', 'greenhouse_map_rows'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0155 aborted: row level security is off on public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '0155 aborted: unexpected policy on public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ROLLBACK (drops every map; Greenhouse Setup and plans are unaffected):
-- begin;
-- drop function if exists public.save_greenhouse_map(uuid, jsonb, uuid, timestamptz);
-- drop table if exists public.greenhouse_map_rows, public.greenhouse_map_phases, public.greenhouse_maps;
-- drop function if exists public.greenhouse_map_phase_matches_organization();
-- commit;
