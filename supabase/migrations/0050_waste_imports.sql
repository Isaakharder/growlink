create table if not exists public.waste_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  variety_id uuid,
  external_variety_id text,
  variety_name_snapshot text not null,
  color text check (color in ('red', 'orange', 'yellow', 'green')),
  year integer not null,
  week integer not null check (week >= 1 and week <= 53),
  waste_kg numeric not null check (waste_kg >= 0),
  source text not null default 'docklink' check (source in ('docklink', 'manual')),
  synced_at timestamptz,
  source_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_variety_id, year, week)
);

create index waste_imports_organization_id_idx on public.waste_imports (organization_id);
create index waste_imports_variety_id_idx on public.waste_imports (variety_id);
create index waste_imports_year_week_idx on public.waste_imports (organization_id, year, week);

alter table public.waste_imports enable row level security;

drop policy if exists waste_imports_select_all on public.waste_imports;
create policy waste_imports_select_all on public.waste_imports
  for select to public using (true);

drop policy if exists waste_imports_insert_all on public.waste_imports;
create policy waste_imports_insert_all on public.waste_imports
  for insert to public with check (true);

drop policy if exists waste_imports_update_all on public.waste_imports;
create policy waste_imports_update_all on public.waste_imports
  for update to public using (true) with check (true);

drop policy if exists waste_imports_delete_all on public.waste_imports;
create policy waste_imports_delete_all on public.waste_imports
  for delete to public using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.waste_imports to anon, authenticated, service_role;
