-- Food Safety module, Phase 1 foundation: departments and locations/assets.
--
-- food_safety_departments: configurable program areas (Irrigation Room,
-- Packing, Sanitation, Chemical Storage, Employee Training, etc).
--
-- food_safety_locations: generic physical locations AND assets (bathrooms,
-- pack lines, coolers, forklifts, chemical rooms, eyewash stations). A single
-- table with a location_type discriminator is used deliberately so future
-- location/asset kinds do not require new tables or migrations — the specific
-- identity of a location/asset lives in `name`, not in its type.
--
-- Neither table has QR codes yet (a later phase) and neither is referenced
-- by any other Food Safety table yet (forms/schedules/tasks/records are
-- later phases) — this migration only establishes the two foundation tables.

create table if not exists public.food_safety_departments (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  name            text        not null,
  description     text,
  active          boolean     not null default true,
  sort_order      integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint food_safety_departments_org_name_key unique (organization_id, name)
);

create index if not exists food_safety_departments_org_idx
  on public.food_safety_departments (organization_id);

create index if not exists food_safety_departments_org_active_sort_idx
  on public.food_safety_departments (organization_id, active, sort_order);

alter table public.food_safety_departments enable row level security;

drop policy if exists food_safety_departments_select_org on public.food_safety_departments;
create policy food_safety_departments_select_org on public.food_safety_departments
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_departments_insert_org on public.food_safety_departments;
create policy food_safety_departments_insert_org on public.food_safety_departments
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_departments_update_org on public.food_safety_departments;
create policy food_safety_departments_update_org on public.food_safety_departments
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_departments_delete_org on public.food_safety_departments;
create policy food_safety_departments_delete_org on public.food_safety_departments
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_departments to service_role;


create table if not exists public.food_safety_locations (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  department_id   uuid        references public.food_safety_departments(id) on delete set null,
  name            text        not null,
  description     text,
  location_type   text        not null default 'location'
                                check (location_type in ('location', 'asset')),
  active          boolean     not null default true,
  sort_order      integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint food_safety_locations_org_name_key unique (organization_id, name)
);

create index if not exists food_safety_locations_org_idx
  on public.food_safety_locations (organization_id);

create index if not exists food_safety_locations_department_idx
  on public.food_safety_locations (organization_id, department_id);

create index if not exists food_safety_locations_org_active_sort_idx
  on public.food_safety_locations (organization_id, active, sort_order);

alter table public.food_safety_locations enable row level security;

drop policy if exists food_safety_locations_select_org on public.food_safety_locations;
create policy food_safety_locations_select_org on public.food_safety_locations
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_locations_insert_org on public.food_safety_locations;
create policy food_safety_locations_insert_org on public.food_safety_locations
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_locations_update_org on public.food_safety_locations;
create policy food_safety_locations_update_org on public.food_safety_locations
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_locations_delete_org on public.food_safety_locations;
create policy food_safety_locations_delete_org on public.food_safety_locations
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_locations to service_role;
