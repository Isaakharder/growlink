create table if not exists public.color_case_entries (
  id uuid primary key default gen_random_uuid(),
  color text not null check (color in ('red', 'orange', 'yellow', 'green')),
  year integer not null,
  week integer not null check (week >= 1 and week <= 53),
  total_cases numeric not null check (total_cases >= 0),
  case_weight_kg numeric not null check (case_weight_kg >= 0),
  total_kg numeric not null default 0 check (total_kg >= 0),
  kg_per_m2 numeric not null default 0 check (kg_per_m2 >= 0),
  color_area_m2 numeric not null default 0 check (color_area_m2 >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.color_case_entries enable row level security;

drop policy if exists color_case_entries_select_all on public.color_case_entries;
create policy color_case_entries_select_all on public.color_case_entries
  for select
  to public
  using (true);

drop policy if exists color_case_entries_insert_all on public.color_case_entries;
create policy color_case_entries_insert_all on public.color_case_entries
  for insert
  to public
  with check (true);

drop policy if exists color_case_entries_update_all on public.color_case_entries;
create policy color_case_entries_update_all on public.color_case_entries
  for update
  to public
  using (true)
  with check (true);

drop policy if exists color_case_entries_delete_all on public.color_case_entries;
create policy color_case_entries_delete_all on public.color_case_entries
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.color_case_entries to anon, authenticated, service_role;
