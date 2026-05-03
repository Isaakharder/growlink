create extension if not exists pgcrypto;

create table if not exists public.irrigation_groups (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('phase', 'zone', 'color')),
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.irrigation_feed_valves (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  group_id uuid not null references public.irrigation_groups(id),
  dripper_count integer not null default 1 check (dripper_count >= 1),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.irrigation_drain_buckets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  group_id uuid not null references public.irrigation_groups(id),
  dripper_count integer not null default 1 check (dripper_count >= 1),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.irrigation_groups enable row level security;
alter table public.irrigation_feed_valves enable row level security;
alter table public.irrigation_drain_buckets enable row level security;

drop policy if exists irrigation_groups_select_all on public.irrigation_groups;
create policy irrigation_groups_select_all on public.irrigation_groups
  for select
  to public
  using (true);

drop policy if exists irrigation_groups_insert_all on public.irrigation_groups;
create policy irrigation_groups_insert_all on public.irrigation_groups
  for insert
  to public
  with check (true);

drop policy if exists irrigation_groups_update_all on public.irrigation_groups;
create policy irrigation_groups_update_all on public.irrigation_groups
  for update
  to public
  using (true)
  with check (true);

drop policy if exists irrigation_groups_delete_all on public.irrigation_groups;
create policy irrigation_groups_delete_all on public.irrigation_groups
  for delete
  to public
  using (true);

drop policy if exists irrigation_feed_valves_select_all on public.irrigation_feed_valves;
create policy irrigation_feed_valves_select_all on public.irrigation_feed_valves
  for select
  to public
  using (true);

drop policy if exists irrigation_feed_valves_insert_all on public.irrigation_feed_valves;
create policy irrigation_feed_valves_insert_all on public.irrigation_feed_valves
  for insert
  to public
  with check (true);

drop policy if exists irrigation_feed_valves_update_all on public.irrigation_feed_valves;
create policy irrigation_feed_valves_update_all on public.irrigation_feed_valves
  for update
  to public
  using (true)
  with check (true);

drop policy if exists irrigation_feed_valves_delete_all on public.irrigation_feed_valves;
create policy irrigation_feed_valves_delete_all on public.irrigation_feed_valves
  for delete
  to public
  using (true);

drop policy if exists irrigation_drain_buckets_select_all on public.irrigation_drain_buckets;
create policy irrigation_drain_buckets_select_all on public.irrigation_drain_buckets
  for select
  to public
  using (true);

drop policy if exists irrigation_drain_buckets_insert_all on public.irrigation_drain_buckets;
create policy irrigation_drain_buckets_insert_all on public.irrigation_drain_buckets
  for insert
  to public
  with check (true);

drop policy if exists irrigation_drain_buckets_update_all on public.irrigation_drain_buckets;
create policy irrigation_drain_buckets_update_all on public.irrigation_drain_buckets
  for update
  to public
  using (true)
  with check (true);

drop policy if exists irrigation_drain_buckets_delete_all on public.irrigation_drain_buckets;
create policy irrigation_drain_buckets_delete_all on public.irrigation_drain_buckets
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.irrigation_groups to anon, authenticated, service_role;
grant all on table public.irrigation_feed_valves to anon, authenticated, service_role;
grant all on table public.irrigation_drain_buckets to anon, authenticated, service_role;
