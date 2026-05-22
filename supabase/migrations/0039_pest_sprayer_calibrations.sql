create table if not exists public.pest_sprayer_calibrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sprayer_id uuid not null references public.pest_sprayers(id) on delete cascade,
  psi integer not null check (psi in (50, 100, 150, 200)),
  nozzle_1_ml_per_min numeric not null check (nozzle_1_ml_per_min > 0),
  nozzle_2_ml_per_min numeric not null check (nozzle_2_ml_per_min > 0),
  nozzle_3_ml_per_min numeric not null check (nozzle_3_ml_per_min > 0),
  avg_ml_per_min numeric generated always as (
    (nozzle_1_ml_per_min + nozzle_2_ml_per_min + nozzle_3_ml_per_min) / 3
  ) stored,
  notes text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (sprayer_id, psi)
);

create index if not exists pest_sprayer_calibrations_org_idx
  on public.pest_sprayer_calibrations (organization_id);

create index if not exists pest_sprayer_calibrations_sprayer_idx
  on public.pest_sprayer_calibrations (sprayer_id);

alter table public.pest_sprayer_calibrations enable row level security;

create policy pest_sprayer_calibrations_select_org on public.pest_sprayer_calibrations
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy pest_sprayer_calibrations_insert_org on public.pest_sprayer_calibrations
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy pest_sprayer_calibrations_update_org on public.pest_sprayer_calibrations
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy pest_sprayer_calibrations_delete_org on public.pest_sprayer_calibrations
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.pest_sprayer_calibrations to anon, authenticated, service_role;
