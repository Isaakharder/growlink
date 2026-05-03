create table if not exists public.daily_yield_bin_settings (
  id uuid primary key default gen_random_uuid(),
  cases_per_bin numeric not null default 38,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.daily_yield_samples (
  id uuid primary key default gen_random_uuid(),
  variety_id uuid not null references public.varieties(id),
  row_id uuid not null references public.greenhouse_rows(id),
  bin_fill_percent numeric not null check (bin_fill_percent >= 0 and bin_fill_percent <= 100),
  created_at timestamptz default now()
);

alter table public.daily_yield_bin_settings enable row level security;
alter table public.daily_yield_samples enable row level security;

drop policy if exists daily_yield_bin_settings_select_all on public.daily_yield_bin_settings;
create policy daily_yield_bin_settings_select_all on public.daily_yield_bin_settings
  for select
  to public
  using (true);

drop policy if exists daily_yield_bin_settings_insert_all on public.daily_yield_bin_settings;
create policy daily_yield_bin_settings_insert_all on public.daily_yield_bin_settings
  for insert
  to public
  with check (true);

drop policy if exists daily_yield_bin_settings_update_all on public.daily_yield_bin_settings;
create policy daily_yield_bin_settings_update_all on public.daily_yield_bin_settings
  for update
  to public
  using (true)
  with check (true);

drop policy if exists daily_yield_bin_settings_delete_all on public.daily_yield_bin_settings;
create policy daily_yield_bin_settings_delete_all on public.daily_yield_bin_settings
  for delete
  to public
  using (true);

drop policy if exists daily_yield_samples_select_all on public.daily_yield_samples;
create policy daily_yield_samples_select_all on public.daily_yield_samples
  for select
  to public
  using (true);

drop policy if exists daily_yield_samples_insert_all on public.daily_yield_samples;
create policy daily_yield_samples_insert_all on public.daily_yield_samples
  for insert
  to public
  with check (true);

drop policy if exists daily_yield_samples_update_all on public.daily_yield_samples;
create policy daily_yield_samples_update_all on public.daily_yield_samples
  for update
  to public
  using (true)
  with check (true);

drop policy if exists daily_yield_samples_delete_all on public.daily_yield_samples;
create policy daily_yield_samples_delete_all on public.daily_yield_samples
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.daily_yield_bin_settings to anon, authenticated, service_role;
grant all on table public.daily_yield_samples to anon, authenticated, service_role;
