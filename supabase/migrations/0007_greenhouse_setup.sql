create extension if not exists pgcrypto;

create table if not exists public.greenhouse_groups (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('phase', 'zone', 'color')),
  name text not null,
  start_row integer not null check (start_row >= 1),
  end_row integer not null check (end_row >= start_row),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.greenhouse_rows (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.greenhouse_groups(id) on delete cascade,
  row_number integer not null check (row_number >= 1),
  slab_count integer not null default 0 check (slab_count >= 0),
  plants_per_slab integer not null default 0 check (plants_per_slab >= 0),
  stems_per_plant numeric not null default 1 check (stems_per_plant > 0),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.greenhouse_variety_assignments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.greenhouse_groups(id) on delete cascade,
  variety_id uuid not null references public.varieties(id),
  start_row integer not null check (start_row >= 1),
  end_row integer not null check (end_row >= start_row),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.greenhouse_groups enable row level security;
alter table public.greenhouse_rows enable row level security;
alter table public.greenhouse_variety_assignments enable row level security;

drop policy if exists greenhouse_groups_select_all on public.greenhouse_groups;
create policy greenhouse_groups_select_all on public.greenhouse_groups
  for select
  to public
  using (true);

drop policy if exists greenhouse_groups_insert_all on public.greenhouse_groups;
create policy greenhouse_groups_insert_all on public.greenhouse_groups
  for insert
  to public
  with check (true);

drop policy if exists greenhouse_groups_update_all on public.greenhouse_groups;
create policy greenhouse_groups_update_all on public.greenhouse_groups
  for update
  to public
  using (true)
  with check (true);

drop policy if exists greenhouse_groups_delete_all on public.greenhouse_groups;
create policy greenhouse_groups_delete_all on public.greenhouse_groups
  for delete
  to public
  using (true);

drop policy if exists greenhouse_rows_select_all on public.greenhouse_rows;
create policy greenhouse_rows_select_all on public.greenhouse_rows
  for select
  to public
  using (true);

drop policy if exists greenhouse_rows_insert_all on public.greenhouse_rows;
create policy greenhouse_rows_insert_all on public.greenhouse_rows
  for insert
  to public
  with check (true);

drop policy if exists greenhouse_rows_update_all on public.greenhouse_rows;
create policy greenhouse_rows_update_all on public.greenhouse_rows
  for update
  to public
  using (true)
  with check (true);

drop policy if exists greenhouse_rows_delete_all on public.greenhouse_rows;
create policy greenhouse_rows_delete_all on public.greenhouse_rows
  for delete
  to public
  using (true);

drop policy if exists greenhouse_assignments_select_all on public.greenhouse_variety_assignments;
create policy greenhouse_assignments_select_all on public.greenhouse_variety_assignments
  for select
  to public
  using (true);

drop policy if exists greenhouse_assignments_insert_all on public.greenhouse_variety_assignments;
create policy greenhouse_assignments_insert_all on public.greenhouse_variety_assignments
  for insert
  to public
  with check (true);

drop policy if exists greenhouse_assignments_update_all on public.greenhouse_variety_assignments;
create policy greenhouse_assignments_update_all on public.greenhouse_variety_assignments
  for update
  to public
  using (true)
  with check (true);

drop policy if exists greenhouse_assignments_delete_all on public.greenhouse_variety_assignments;
create policy greenhouse_assignments_delete_all on public.greenhouse_variety_assignments
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.greenhouse_groups to anon, authenticated, service_role;
grant all on table public.greenhouse_rows to anon, authenticated, service_role;
grant all on table public.greenhouse_variety_assignments to anon, authenticated, service_role;
