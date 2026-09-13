-- Bogaerts Qii-Jet spray method — V1 schema.
--
-- Parallel to (not a reuse of) public.pest_sprayers: the Qii-Jet is an
-- automated robot with no PSI-vs-flow calibration curve or travel-speed
-- concept, so it gets its own equipment tables rather than overloading the
-- Wanjet-shaped one.
--
-- Deliberately excluded from this migration: nozzle flow-curve data
-- (pressure -> L/min per nozzle type). V1 only records/displays nozzle
-- type + active nozzle count + pressure; it does not calculate or validate
-- achievable flow. A pest_bogaerts_nozzle_flow_curve table will be added
-- once verified manual data is available.

create table if not exists public.pest_bogaerts_robots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  tank_volume_liters numeric not null default 300 check (tank_volume_liters > 0),
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists pest_bogaerts_robots_organization_id_idx
  on public.pest_bogaerts_robots (organization_id);

alter table public.pest_bogaerts_robots enable row level security;

create policy pest_bogaerts_robots_select_org on public.pest_bogaerts_robots
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy pest_bogaerts_robots_insert_org on public.pest_bogaerts_robots
  for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy pest_bogaerts_robots_update_org on public.pest_bogaerts_robots
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy pest_bogaerts_robots_delete_org on public.pest_bogaerts_robots
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.pest_bogaerts_robots to anon, authenticated, service_role;

-- Nozzle types (Yellow 020/110020, Green 015/110015, Orange 010/110010, etc.)
-- Free-text/org-managed rather than seeded: the exact set in use varies by
-- operation, and no flow-curve data is being trusted from this migration.

create table if not exists public.pest_bogaerts_nozzle_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  color text,
  spray_tip_code text,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists pest_bogaerts_nozzle_types_organization_id_idx
  on public.pest_bogaerts_nozzle_types (organization_id);

alter table public.pest_bogaerts_nozzle_types enable row level security;

create policy pest_bogaerts_nozzle_types_select_org on public.pest_bogaerts_nozzle_types
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy pest_bogaerts_nozzle_types_insert_org on public.pest_bogaerts_nozzle_types
  for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy pest_bogaerts_nozzle_types_update_org on public.pest_bogaerts_nozzle_types
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy pest_bogaerts_nozzle_types_delete_org on public.pest_bogaerts_nozzle_types
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant all on table public.pest_bogaerts_nozzle_types to anon, authenticated, service_role;
