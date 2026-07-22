-- Quality Check "Bonuses" tab: bonus tiers (setup) and bonus entries (calculated/saved records).
-- Reuses quality_employees and the existing check_type enum (winding_pruning / picking_peppers)
-- rather than introducing a separate employee list or job-type enum.

create table if not exists public.quality_bonus_tiers (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null references public.organizations(id) on delete cascade,
  check_type           text        not null check (check_type in ('winding_pruning', 'picking_peppers')),
  min_speed            numeric     not null check (min_speed > 0),
  bonus_rate_per_hour  numeric     not null check (bonus_rate_per_hour >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid
);

-- Duplicate thresholds are not allowed within the same job/org.
create unique index if not exists quality_bonus_tiers_org_type_speed_key
  on public.quality_bonus_tiers (organization_id, check_type, min_speed);

create index if not exists quality_bonus_tiers_org_idx
  on public.quality_bonus_tiers (organization_id, check_type);

create table if not exists public.quality_bonus_entries (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  employee_id         uuid        not null references public.quality_employees(id),
  employee_name       text        not null,
  entry_date          date        not null,
  check_type          text        not null check (check_type in ('winding_pruning', 'picking_peppers')),
  entered_speed       numeric     not null check (entered_speed >= 0),
  speed_unit          text        not null,
  hours_worked        numeric     not null check (hours_worked > 0),
  applied_threshold   numeric,
  applied_rate        numeric     not null default 0,
  total_bonus         numeric     not null default 0,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz,
  updated_by          uuid
);

create index if not exists quality_bonus_entries_org_idx      on public.quality_bonus_entries (organization_id);
create index if not exists quality_bonus_entries_employee_idx on public.quality_bonus_entries (employee_id);
create index if not exists quality_bonus_entries_date_idx     on public.quality_bonus_entries (organization_id, entry_date desc);
create index if not exists quality_bonus_entries_type_idx     on public.quality_bonus_entries (organization_id, check_type);

-- RLS
alter table public.quality_bonus_tiers   enable row level security;
alter table public.quality_bonus_entries enable row level security;

drop policy if exists quality_bonus_tiers_select on public.quality_bonus_tiers;
create policy quality_bonus_tiers_select on public.quality_bonus_tiers
  for select to authenticated using (public.is_org_member(organization_id));
drop policy if exists quality_bonus_tiers_insert on public.quality_bonus_tiers;
create policy quality_bonus_tiers_insert on public.quality_bonus_tiers
  for insert to authenticated with check (public.is_org_member(organization_id));
drop policy if exists quality_bonus_tiers_update on public.quality_bonus_tiers;
create policy quality_bonus_tiers_update on public.quality_bonus_tiers
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
drop policy if exists quality_bonus_tiers_delete on public.quality_bonus_tiers;
create policy quality_bonus_tiers_delete on public.quality_bonus_tiers
  for delete to authenticated using (public.is_org_member(organization_id));

drop policy if exists quality_bonus_entries_select on public.quality_bonus_entries;
create policy quality_bonus_entries_select on public.quality_bonus_entries
  for select to authenticated using (public.is_org_member(organization_id));
drop policy if exists quality_bonus_entries_insert on public.quality_bonus_entries;
create policy quality_bonus_entries_insert on public.quality_bonus_entries
  for insert to authenticated with check (public.is_org_member(organization_id));
drop policy if exists quality_bonus_entries_update on public.quality_bonus_entries;
create policy quality_bonus_entries_update on public.quality_bonus_entries
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
drop policy if exists quality_bonus_entries_delete on public.quality_bonus_entries;
create policy quality_bonus_entries_delete on public.quality_bonus_entries
  for delete to authenticated using (public.is_org_member(organization_id));

-- Server-only tables (accessed through the Express API with the service-role key).
grant select, insert, update, delete on table public.quality_bonus_tiers   to service_role;
grant select, insert, update, delete on table public.quality_bonus_entries to service_role;
