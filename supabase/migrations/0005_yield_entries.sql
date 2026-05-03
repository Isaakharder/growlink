create extension if not exists pgcrypto;

create table if not exists public.yield_entries (
  id uuid primary key default gen_random_uuid(),
  variety_id uuid not null references public.varieties(id),
  year integer not null,
  week integer not null check (week >= 1 and week <= 53),
  size_kg jsonb not null default '{}'::jsonb,
  total_kg numeric not null default 0,
  average_fruit_weight_g numeric,
  kg_per_m2 numeric not null default 0,
  total_cases numeric not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.yield_entries enable row level security;

drop policy if exists yield_entries_select_all on public.yield_entries;
create policy yield_entries_select_all on public.yield_entries
  for select
  to public
  using (true);

drop policy if exists yield_entries_insert_all on public.yield_entries;
create policy yield_entries_insert_all on public.yield_entries
  for insert
  to public
  with check (true);

drop policy if exists yield_entries_update_all on public.yield_entries;
create policy yield_entries_update_all on public.yield_entries
  for update
  to public
  using (true)
  with check (true);

drop policy if exists yield_entries_delete_all on public.yield_entries;
create policy yield_entries_delete_all on public.yield_entries
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.yield_entries to anon, authenticated, service_role;
