create table if not exists public.pest_chemicals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  active boolean not null default true,
  inventory_qty numeric not null default 0 check (inventory_qty >= 0),
  inventory_unit text not null default 'L',
  rate_value numeric not null check (rate_value >= 0),
  rate_basis text not null check (
    rate_basis in ('per_acre', 'per_hectare', 'per_1000L_water', 'per_L_water')
  ),
  pest_target text not null default '',
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists pest_chemicals_organization_id_idx on public.pest_chemicals (organization_id);

alter table public.pest_chemicals enable row level security;

create policy pest_chemicals_select_org on public.pest_chemicals
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy pest_chemicals_insert_org on public.pest_chemicals
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy pest_chemicals_update_org on public.pest_chemicals
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy pest_chemicals_delete_org on public.pest_chemicals
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.pest_chemicals to anon, authenticated, service_role;
