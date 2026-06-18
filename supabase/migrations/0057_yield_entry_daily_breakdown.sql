-- yield_entry_daily_breakdown: one row per packing day per weekly yield entry.
-- Supports accurate per-day KG display on the week summary cards without
-- changing the weekly yield_entries total or its unique constraint.

create table if not exists public.yield_entry_daily_breakdown (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id),
  yield_entry_id  uuid        not null references public.yield_entries(id) on delete cascade,
  packed_date     date,
  size_kg         jsonb       not null default '{}',
  total_kg        numeric     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists yield_entry_daily_breakdown_entry_id_idx
  on public.yield_entry_daily_breakdown (yield_entry_id);

create index if not exists yield_entry_daily_breakdown_org_date_idx
  on public.yield_entry_daily_breakdown (organization_id, packed_date);

alter table public.yield_entry_daily_breakdown enable row level security;

create policy yield_entry_daily_breakdown_select_org on public.yield_entry_daily_breakdown
  for select to authenticated using (public.is_org_member(organization_id));

create policy yield_entry_daily_breakdown_insert_org on public.yield_entry_daily_breakdown
  for insert to authenticated with check (public.is_org_member(organization_id));

create policy yield_entry_daily_breakdown_update_org on public.yield_entry_daily_breakdown
  for update to authenticated
  using  (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy yield_entry_daily_breakdown_delete_org on public.yield_entry_daily_breakdown
  for delete to authenticated using (public.is_org_member(organization_id));

grant all on table public.yield_entry_daily_breakdown to anon, authenticated, service_role;
