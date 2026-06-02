-- Weekly yield projections: variety-level or color-level, kg or cases.
-- Users enter a projected amount per week, then compare against actual data.

create table if not exists public.yield_projections (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id),
  year              integer     not null,
  week              integer     not null check (week between 1 and 52),
  projection_level  text        not null check (projection_level in ('variety', 'color')),
  variety_id        uuid        references public.varieties(id),
  color             text        check (color in ('red', 'orange', 'yellow', 'green')),
  unit              text        not null check (unit in ('kg', 'cases')),
  projected_amount  numeric     not null check (projected_amount >= 0),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Indexes
create index if not exists yield_projections_org_idx
  on public.yield_projections (organization_id);
create index if not exists yield_projections_org_year_idx
  on public.yield_projections (organization_id, year);

-- Partial unique indexes for upsert — handles NULLs correctly.
-- variety-level: unique per (org, year, week, variety, unit)
create unique index if not exists yield_projections_variety_uq
  on public.yield_projections (organization_id, year, week, variety_id, unit)
  where projection_level = 'variety';

-- color-level: unique per (org, year, week, color, unit)
create unique index if not exists yield_projections_color_uq
  on public.yield_projections (organization_id, year, week, color, unit)
  where projection_level = 'color';

-- RLS
alter table public.yield_projections enable row level security;

create policy yield_projections_select on public.yield_projections
  for select to authenticated using (public.is_org_member(organization_id));

create policy yield_projections_insert on public.yield_projections
  for insert to authenticated with check (public.is_org_member(organization_id));

create policy yield_projections_update on public.yield_projections
  for update to authenticated
  using  (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy yield_projections_delete on public.yield_projections
  for delete to authenticated using (public.is_org_member(organization_id));

-- Grants
grant all on table public.yield_projections to anon, authenticated, service_role;
