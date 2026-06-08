-- Migration 0049: Daily light intensity logs (Joules/cm²)
-- One entry per organization per date. Upsert-safe unique constraint.

create table if not exists public.daily_light_logs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  log_date        date not null,
  joules_per_cm2  numeric not null check (joules_per_cm2 >= 0),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, log_date)
);

create index if not exists daily_light_logs_org_date_idx
  on public.daily_light_logs (organization_id, log_date desc);

alter table public.daily_light_logs enable row level security;

create policy daily_light_logs_select on public.daily_light_logs
  for select to authenticated using (public.is_org_member(organization_id));

create policy daily_light_logs_insert on public.daily_light_logs
  for insert to authenticated with check (public.is_org_member(organization_id));

create policy daily_light_logs_update on public.daily_light_logs
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy daily_light_logs_delete on public.daily_light_logs
  for delete to authenticated using (public.is_org_member(organization_id));

grant all on table public.daily_light_logs to anon, authenticated, service_role;
