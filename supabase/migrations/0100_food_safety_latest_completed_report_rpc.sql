-- Read-only helper for the mobile Food Safety location list: the most
-- recent FINALIZED report (completed_at, completed_by_initials) per
-- location, in one query instead of one query per location.
--
-- Uses `distinct on (location_id) ... order by location_id, completed_at
-- desc`, which Postgres can satisfy directly off the existing
-- food_safety_cleaning_reports_location_completed_idx index (location_id,
-- completed_at desc) from migration 0088 — no new index needed.
--
-- Deliberately reads from food_safety_cleaning_reports only (the immutable,
-- finalized-report table), never food_safety_cleaning_checklists — an
-- in-progress/incomplete checklist must never influence this value. No new
-- column is added anywhere; this is purely a read aggregation.
create or replace function public.food_safety_latest_reports_for_locations(
  p_organization_id uuid,
  p_location_ids uuid[]
)
returns table (location_id uuid, completed_at timestamptz, completed_by_initials text)
language sql
stable
as $$
  select distinct on (r.location_id) r.location_id, r.completed_at, r.completed_by_initials
  from public.food_safety_cleaning_reports r
  where r.organization_id = p_organization_id
    and r.location_id = any(p_location_ids)
  order by r.location_id, r.completed_at desc;
$$;

grant execute on function public.food_safety_latest_reports_for_locations(uuid, uuid[]) to service_role;
