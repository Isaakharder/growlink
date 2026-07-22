-- Auto-adjusting bonus thresholds: per-job mode (fixed vs auto), a reference
-- workload baseline, an interpolated multiplier curve (kg/m^2 for Picking,
-- sets-per-plant for Winding/Pruning), and a categorical pruning-workload
-- multiplier (Winding/Pruning only). Existing quality_bonus_tiers rows are
-- reused unchanged as the "reference" tiers when a job is in auto mode.

create table if not exists public.quality_bonus_adjustment_settings (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  check_type        text        not null check (check_type in ('winding_pruning', 'picking_peppers')),
  threshold_mode    text        not null default 'fixed' check (threshold_mode in ('fixed', 'auto')),
  reference_value   numeric,    -- reference kg/m^2 (picking) or reference sets-per-plant (winding_pruning)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists quality_bonus_adjustment_settings_org_type_key
  on public.quality_bonus_adjustment_settings (organization_id, check_type);

-- Interpolated multiplier curve. axis selects which weekly input this curve
-- applies to: picking_peppers always uses 'crop_load', winding_pruning
-- always uses 'sets_per_plant'.
create table if not exists public.quality_bonus_multiplier_points (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  check_type        text        not null check (check_type in ('winding_pruning', 'picking_peppers')),
  axis              text        not null check (axis in ('crop_load', 'sets_per_plant')),
  reference_value   numeric     not null check (reference_value >= 0),
  multiplier        numeric     not null check (multiplier > 0),
  created_at        timestamptz not null default now()
);

create unique index if not exists quality_bonus_multiplier_points_key
  on public.quality_bonus_multiplier_points (organization_id, check_type, axis, reference_value);

create index if not exists quality_bonus_multiplier_points_lookup_idx
  on public.quality_bonus_multiplier_points (organization_id, check_type, axis);

-- Categorical pruning-workload multiplier (winding_pruning only; three rows
-- per org — light/normal/heavy — managed via PATCH, not add/delete).
create table if not exists public.quality_bonus_workload_levels (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  check_type        text        not null check (check_type in ('winding_pruning', 'picking_peppers')),
  workload_level    text        not null check (workload_level in ('light', 'normal', 'heavy')),
  multiplier        numeric     not null check (multiplier > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists quality_bonus_workload_levels_key
  on public.quality_bonus_workload_levels (organization_id, check_type, workload_level);

-- Historical calculation inputs on every saved bonus record, so that
-- changing Setup/adjustment configuration later never changes past bonuses.
-- applied_threshold keeps its existing meaning (the threshold actually
-- compared against — i.e. the ADJUSTED threshold when auto mode was used).
alter table public.quality_bonus_entries
  add column if not exists base_threshold          numeric,
  add column if not exists adjustment_multiplier    numeric not null default 1,
  add column if not exists weekly_crop_load         numeric,
  add column if not exists weekly_sets_per_plant    numeric,
  add column if not exists weekly_pruning_workload  text check (weekly_pruning_workload in ('light', 'normal', 'heavy'));

-- RLS
alter table public.quality_bonus_adjustment_settings enable row level security;
alter table public.quality_bonus_multiplier_points    enable row level security;
alter table public.quality_bonus_workload_levels      enable row level security;

drop policy if exists quality_bonus_adjustment_settings_select on public.quality_bonus_adjustment_settings;
create policy quality_bonus_adjustment_settings_select on public.quality_bonus_adjustment_settings
  for select to authenticated using (public.is_org_member(organization_id));
drop policy if exists quality_bonus_adjustment_settings_insert on public.quality_bonus_adjustment_settings;
create policy quality_bonus_adjustment_settings_insert on public.quality_bonus_adjustment_settings
  for insert to authenticated with check (public.is_org_member(organization_id));
drop policy if exists quality_bonus_adjustment_settings_update on public.quality_bonus_adjustment_settings;
create policy quality_bonus_adjustment_settings_update on public.quality_bonus_adjustment_settings
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists quality_bonus_multiplier_points_select on public.quality_bonus_multiplier_points;
create policy quality_bonus_multiplier_points_select on public.quality_bonus_multiplier_points
  for select to authenticated using (public.is_org_member(organization_id));
drop policy if exists quality_bonus_multiplier_points_insert on public.quality_bonus_multiplier_points;
create policy quality_bonus_multiplier_points_insert on public.quality_bonus_multiplier_points
  for insert to authenticated with check (public.is_org_member(organization_id));
drop policy if exists quality_bonus_multiplier_points_update on public.quality_bonus_multiplier_points;
create policy quality_bonus_multiplier_points_update on public.quality_bonus_multiplier_points
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
drop policy if exists quality_bonus_multiplier_points_delete on public.quality_bonus_multiplier_points;
create policy quality_bonus_multiplier_points_delete on public.quality_bonus_multiplier_points
  for delete to authenticated using (public.is_org_member(organization_id));

drop policy if exists quality_bonus_workload_levels_select on public.quality_bonus_workload_levels;
create policy quality_bonus_workload_levels_select on public.quality_bonus_workload_levels
  for select to authenticated using (public.is_org_member(organization_id));
drop policy if exists quality_bonus_workload_levels_insert on public.quality_bonus_workload_levels;
create policy quality_bonus_workload_levels_insert on public.quality_bonus_workload_levels
  for insert to authenticated with check (public.is_org_member(organization_id));
drop policy if exists quality_bonus_workload_levels_update on public.quality_bonus_workload_levels;
create policy quality_bonus_workload_levels_update on public.quality_bonus_workload_levels
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- Server-only tables (accessed through the Express API with the service-role key).
grant select, insert, update, delete on table public.quality_bonus_adjustment_settings to service_role;
grant select, insert, update, delete on table public.quality_bonus_multiplier_points    to service_role;
grant select, insert, update, delete on table public.quality_bonus_workload_levels      to service_role;
