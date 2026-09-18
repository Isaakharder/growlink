-- Maintenance module — Setup schema (categories, locations, part types).
--
-- New module for tracking greenhouse equipment, its scheduled maintenance,
-- and a parts inventory. This first migration adds the three small
-- "Setup" reference tables that Equipment and Inventory (added in 0128/0129)
-- attach to:
--   - maintenance_categories   — used to organize equipment (Irrigation,
--                                Vehicles, Spray Equipment, etc.)
--   - maintenance_locations    — shared by BOTH equipment and inventory
--                                (Phase 1, Warehouse, Boiler Room, etc.)
--   - maintenance_part_types   — used to organize inventory parts
--                                (Bearings, Belts, Motors, etc.)
--
-- Same shape as food_safety_cleaning_locations (org-scoped name/description/
-- active), but using flowmaster_size_rules' case-insensitive-unique pattern
-- (a generated, trimmed+lowercased column promoted to a named unique
-- constraint — required, not just a bare index, for Supabase's upsert
-- onConflict per this repo's own convention) instead of a plain-text unique
-- constraint, since names must be unique per org after trim/case
-- normalization.
--
-- "Safe delete when unused, force-inactive when referenced" is enforced by
-- the database itself, not a pre-check in the API: every foreign key from
-- maintenance_equipment/maintenance_inventory_items into these three tables
-- (added in 0128/0129) is `on delete restrict`, so a real DELETE attempt on
-- a referenced row fails with Postgres error 23503 and the route handler
-- converts that into a 409 asking the user to deactivate instead. This
-- avoids a check-then-delete race between two concurrent requests.
--
-- Push-notification note: a future maintenance_notification_events table
-- (for real push delivery, once GrowLink has push infrastructure) can
-- reference schedule_id/equipment_id/inventory_item_id and be added later
-- without altering anything in this module's schema.

-- ============================================================
-- maintenance_categories
-- ============================================================

create table public.maintenance_categories (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  name              text        not null,
  name_normalized   text        generated always as (lower(trim(name))) stored,
  description       text,
  display_order     integer     not null default 0,
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid        references auth.users(id) on delete set null,
  updated_by        uuid        references auth.users(id) on delete set null,
  constraint maintenance_categories_org_name_unique unique (organization_id, name_normalized)
);

create index maintenance_categories_org_active_idx
  on public.maintenance_categories (organization_id, is_active, display_order);

alter table public.maintenance_categories enable row level security;

create policy maintenance_categories_select_org on public.maintenance_categories
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_categories_insert_org on public.maintenance_categories
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_categories_update_org on public.maintenance_categories
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_categories_delete_org on public.maintenance_categories
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_categories to service_role;

-- ============================================================
-- maintenance_locations (shared by equipment + inventory)
-- ============================================================

create table public.maintenance_locations (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  name              text        not null,
  name_normalized   text        generated always as (lower(trim(name))) stored,
  description       text,
  display_order     integer     not null default 0,
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid        references auth.users(id) on delete set null,
  updated_by        uuid        references auth.users(id) on delete set null,
  constraint maintenance_locations_org_name_unique unique (organization_id, name_normalized)
);

create index maintenance_locations_org_active_idx
  on public.maintenance_locations (organization_id, is_active, display_order);

alter table public.maintenance_locations enable row level security;

create policy maintenance_locations_select_org on public.maintenance_locations
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_locations_insert_org on public.maintenance_locations
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_locations_update_org on public.maintenance_locations
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_locations_delete_org on public.maintenance_locations
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_locations to service_role;

-- ============================================================
-- maintenance_part_types
-- ============================================================

create table public.maintenance_part_types (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  name              text        not null,
  name_normalized   text        generated always as (lower(trim(name))) stored,
  description       text,
  display_order     integer     not null default 0,
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid        references auth.users(id) on delete set null,
  updated_by        uuid        references auth.users(id) on delete set null,
  constraint maintenance_part_types_org_name_unique unique (organization_id, name_normalized)
);

create index maintenance_part_types_org_active_idx
  on public.maintenance_part_types (organization_id, is_active, display_order);

alter table public.maintenance_part_types enable row level security;

create policy maintenance_part_types_select_org on public.maintenance_part_types
  for select to authenticated using (public.is_org_member(organization_id));
create policy maintenance_part_types_insert_org on public.maintenance_part_types
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy maintenance_part_types_update_org on public.maintenance_part_types
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy maintenance_part_types_delete_org on public.maintenance_part_types
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.maintenance_part_types to service_role;

-- ============================================================
-- Shared immutability-trigger function for immutable Maintenance tables
-- added in later migrations (meter readings, schedule completions,
-- inventory transactions). One shared function (not one per table, unlike
-- pest_calibration_prevent_mutation/food_safety_prevent_mutation) since the
-- error message doesn't need per-table wording.
-- ============================================================

create function public.maintenance_prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'This row is part of an immutable maintenance record and cannot be changed.'
    using errcode = '42501';
end;
$$;
