-- Standalone tanks that can be referenced by sprayers
create table if not exists public.pest_tanks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  volume_liters numeric not null check (volume_liters > 0),
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists pest_tanks_organization_id_idx on public.pest_tanks (organization_id);

alter table public.pest_tanks enable row level security;

create policy pest_tanks_select_org on public.pest_tanks
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy pest_tanks_insert_org on public.pest_tanks
  for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy pest_tanks_update_org on public.pest_tanks
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy pest_tanks_delete_org on public.pest_tanks
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant all on table public.pest_tanks to anon, authenticated, service_role;

-- Tank support on sprayers (built-in or linked standalone tank)
alter table public.pest_sprayers
  add column if not exists has_tank boolean not null default false,
  add column if not exists tank_volume_liters numeric check (tank_volume_liters > 0),
  add column if not exists tank_id uuid references public.pest_tanks(id) on delete set null;

-- Planned application todos
create table if not exists public.pest_control_todos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  type text not null check (type in ('spray', 'drench')),
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  chemical_id uuid references public.pest_chemicals(id) on delete set null,
  chemical_snapshot jsonb not null default '{}',
  target_snapshot jsonb not null default '{}',
  sprayer_snapshot jsonb not null default '{}',
  tank_snapshot jsonb not null default '{}',
  calculation_snapshot jsonb not null default '{}',
  instructions text,
  created_by uuid,
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists pest_control_todos_organization_id_idx on public.pest_control_todos (organization_id);
create index if not exists pest_control_todos_status_idx on public.pest_control_todos (status);

alter table public.pest_control_todos enable row level security;

create policy pest_control_todos_select_org on public.pest_control_todos
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy pest_control_todos_insert_org on public.pest_control_todos
  for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy pest_control_todos_update_org on public.pest_control_todos
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy pest_control_todos_delete_org on public.pest_control_todos
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant all on table public.pest_control_todos to anon, authenticated, service_role;
