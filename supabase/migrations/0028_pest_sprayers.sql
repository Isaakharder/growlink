create table if not exists public.pest_sprayers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  nozzle_count integer not null check (nozzle_count > 0),
  nozzle_volume_l_per_min numeric not null check (nozzle_volume_l_per_min >= 0),
  nozzle_psi numeric not null check (nozzle_psi >= 0),
  speed_m_per_min numeric not null check (speed_m_per_min >= 20 and speed_m_per_min <= 80),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists pest_sprayers_organization_id_idx on public.pest_sprayers (organization_id);

alter table public.pest_sprayers enable row level security;

create policy pest_sprayers_select_org on public.pest_sprayers
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy pest_sprayers_insert_org on public.pest_sprayers
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy pest_sprayers_update_org on public.pest_sprayers
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy pest_sprayers_delete_org on public.pest_sprayers
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.pest_sprayers to anon, authenticated, service_role;
