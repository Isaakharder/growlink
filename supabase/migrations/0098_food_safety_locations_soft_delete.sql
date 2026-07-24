-- Location "delete" changes from a hard delete to a soft delete
-- (is_active = false), so that a deactivated location's historical reports
-- stay reachable through the app rather than becoming orphaned the moment
-- the location row disappears (food_safety_cleaning_reports.location_id is
-- ON DELETE SET NULL specifically to preserve the report row itself, but
-- with no UI path left to find it once the location was gone entirely).
--
-- Because the location row now persists indefinitely after "deletion", name
-- uniqueness must only apply among ACTIVE locations -- reusing a name for a
-- new location after the old one was deactivated needs to keep working.
-- The previous (organization_id, name) unique constraint applied
-- unconditionally and case-sensitively; replaced with a partial,
-- case-insensitive unique index scoped to active locations only.

alter table public.food_safety_cleaning_locations
  drop constraint if exists food_safety_cleaning_locations_org_name_key;

create unique index if not exists food_safety_cleaning_locations_org_active_name_key
  on public.food_safety_cleaning_locations (organization_id, lower(name))
  where is_active;
