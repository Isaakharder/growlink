create table if not exists public.mobile_irrigation_logs (
  id uuid primary key default gen_random_uuid(),
  log_date date not null,
  tracking_mode text not null check (tracking_mode in ('phase', 'zone', 'color')),
  group_id uuid references public.irrigation_groups(id),
  group_key text not null,
  group_name text not null,
  feed_valve_ids uuid[] not null default '{}',
  drain_bucket_ids uuid[] not null default '{}',
  feed_ph numeric,
  feed_ec numeric,
  drain_ph numeric,
  drain_ec numeric,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (log_date, group_key)
);

create index if not exists mobile_irrigation_logs_log_date_idx
  on public.mobile_irrigation_logs (log_date);

create index if not exists mobile_irrigation_logs_group_idx
  on public.mobile_irrigation_logs (group_id, log_date);

alter table public.mobile_irrigation_logs enable row level security;

drop policy if exists mobile_irrigation_logs_select_all on public.mobile_irrigation_logs;
create policy mobile_irrigation_logs_select_all on public.mobile_irrigation_logs
  for select
  to public
  using (true);

drop policy if exists mobile_irrigation_logs_insert_all on public.mobile_irrigation_logs;
create policy mobile_irrigation_logs_insert_all on public.mobile_irrigation_logs
  for insert
  to public
  with check (true);

drop policy if exists mobile_irrigation_logs_update_all on public.mobile_irrigation_logs;
create policy mobile_irrigation_logs_update_all on public.mobile_irrigation_logs
  for update
  to public
  using (true)
  with check (true);

drop policy if exists mobile_irrigation_logs_delete_all on public.mobile_irrigation_logs;
create policy mobile_irrigation_logs_delete_all on public.mobile_irrigation_logs
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.mobile_irrigation_logs to anon, authenticated, service_role;
