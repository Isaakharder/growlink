-- One-time historical data correction, requested 2026-07-27 for First Light
-- Greenhouses inc:
--
-- Before Dave Quiring (account created 2026-07-23) had his own GrowLink
-- login, he completed several "Exterior Premises Inspection - Monthly"
-- inspections while logged into isaak's account. Every one of those reports
-- currently shows "isaak (IS)" as the completing employee; they should show
-- Dave Quiring instead.
--
-- Investigation: this location has exactly 7 reports total, all attributed
-- to isaak. Every one of the 7 (and every checked item on every one of
-- them) was actually submitted on 2026-07-27 within a single ~6-minute
-- window (generated_at / checked_at all cluster around 12:55-13:03 UTC that
-- day), each backdated to a different month (Jan-Jul 2026) via the mobile
-- app's long-press backdate selector. None of the 7 look like a distinct,
-- ordinary same-day completion isaak did himself -- confirmed with the user
-- before running this script that all 7 should move to Dave.
--
-- isaak genuinely has 72 reports at "Packing Line / Packing Area." and 1 at
-- "Washroom 2" -- those must NOT be touched. Dave currently has zero reports
-- anywhere in the system, which gives a clean before/after check in Step 3.
--
-- Scope, precisely: only food_safety_cleaning_reports rows where
-- location_id = the Exterior Premises location AND completed_by_user_id =
-- isaak get updated, plus the food_safety_cleaning_report_items rows
-- belonging to exactly those reports where checked_by_user_id = isaak. Only
-- the employee/user reference columns change (completed_by_user_id/name/
-- initials on reports; checked_by_user_id/name/initials on report_items).
-- completed_at, checked_at, created_at, generated_at, generated_by_user_id,
-- response_value, and every other column are left byte-for-byte unchanged --
-- this corrects who did the work, not when it happened or what was found.
--
-- IMPORTANT -- like the earlier Washroom 1 cleanup, this overrides the
-- deliberate immutability trigger on food_safety_cleaning_reports and
-- food_safety_cleaning_report_items (migrations 0088/0090), which
-- unconditionally rejects UPDATE/DELETE so completed reports can't be
-- edited or lost by accident. It's disabled only for the duration of this
-- one transaction and re-enabled before commit; any error rolls back the
-- disable too, so the safeguard can never be left off.
--
-- Not safe to run twice for meaningful effect (the second run is a no-op:
-- no report at this location is still attributed to isaak), but harmless to
-- re-run.


-- =========================================================================
-- STEP 1 -- PREVIEW (read-only). Run first and confirm every row listed is
-- exactly what should change before running Step 2.
-- =========================================================================

with dave as (
  select
    u.id,
    u.raw_user_meta_data ->> 'full_name' as name,
    case
      when array_length(regexp_split_to_array(trim(u.raw_user_meta_data ->> 'full_name'), '\s+'), 1) = 1
        then upper(left(trim(u.raw_user_meta_data ->> 'full_name'), 2))
      else upper(
        left((regexp_split_to_array(trim(u.raw_user_meta_data ->> 'full_name'), '\s+'))[1], 1) ||
        left(
          (regexp_split_to_array(trim(u.raw_user_meta_data ->> 'full_name'), '\s+'))
            [array_length(regexp_split_to_array(trim(u.raw_user_meta_data ->> 'full_name'), '\s+'), 1)],
          1
        )
      )
    end as initials
  from auth.users u
  join public.memberships m on m.user_id = u.id
  join public.organizations o on o.id = m.organization_id
  where o.name = 'First Light Greenhouses inc'
    and u.raw_user_meta_data ->> 'full_name' = 'Dave Quiring'
)
select
  r.id as report_id,
  r.completed_at,
  r.completed_by_name || ' (' || r.completed_by_initials || ')' as current_employee,
  dave.name || ' (' || dave.initials || ')' as new_employee
from public.food_safety_cleaning_reports r
join public.food_safety_cleaning_locations l on l.id = r.location_id
join public.organizations o on o.id = l.organization_id
cross join dave
where o.name = 'First Light Greenhouses inc'
  and l.name = 'Exterior Premises Inspection - Monthly'
  and r.completed_by_user_id = (
    select u2.id
    from auth.users u2
    join public.memberships m2 on m2.user_id = u2.id
    where m2.organization_id = o.id and u2.email = 'isaak@firstlightgh.ca'
  )
order by r.completed_at;

-- Sanity check: confirms isaak's OTHER locations are untouched by this
-- script's scope -- these counts must be unaffected by Step 2.
select l.name as location_name, count(*) as isaak_report_count
from public.food_safety_cleaning_reports r
join public.food_safety_cleaning_locations l on l.id = r.location_id
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and r.completed_by_name = 'isaak'
group by l.name
order by l.name;


-- =========================================================================
-- STEP 2 -- CORRECTION (destructive). Only run after reviewing Step 1.
-- =========================================================================

begin;

create temporary table exterior_attribution_fix_summary (
  step text,
  detail text,
  row_count integer
) on commit preserve rows;

do $$
declare
  v_org_id uuid;
  v_location_id uuid;
  v_isaak_id uuid;
  v_dave_id uuid;
  v_dave_name text;
  v_dave_initials text;
  v_name_parts text[];
  v_reports_updated integer;
  v_items_updated integer;
begin
  -- Resolve the organization by name; hard-stop if it's not exactly one row.
  select id into v_org_id
  from public.organizations
  where name = 'First Light Greenhouses inc';

  if v_org_id is null then
    raise exception 'Organization "First Light Greenhouses inc" not found -- aborting.';
  end if;

  if (select count(*) from public.organizations where name = 'First Light Greenhouses inc') > 1 then
    raise exception 'More than one organization named "First Light Greenhouses inc" -- aborting.';
  end if;

  -- Resolve the location by name; hard-stop unless there's exactly one match.
  select id into v_location_id
  from public.food_safety_cleaning_locations
  where organization_id = v_org_id
    and name = 'Exterior Premises Inspection - Monthly';

  if v_location_id is null then
    raise exception 'Location "Exterior Premises Inspection - Monthly" not found -- aborting.';
  end if;

  if (select count(*) from public.food_safety_cleaning_locations
      where organization_id = v_org_id and name = 'Exterior Premises Inspection - Monthly') > 1 then
    raise exception 'More than one "Exterior Premises Inspection - Monthly" location found -- aborting.';
  end if;

  -- Resolve isaak (the account these reports currently belong to) by email,
  -- scoped to this org's membership; hard-stop unless exactly one match.
  select u.id into v_isaak_id
  from auth.users u
  join public.memberships m on m.user_id = u.id
  where m.organization_id = v_org_id and u.email = 'isaak@firstlightgh.ca';

  if v_isaak_id is null then
    raise exception 'isaak@firstlightgh.ca not found as a member of this organization -- aborting.';
  end if;

  if (select count(*) from auth.users u
      join public.memberships m on m.user_id = u.id
      where m.organization_id = v_org_id and u.email = 'isaak@firstlightgh.ca') > 1 then
    raise exception 'More than one membership found for isaak@firstlightgh.ca -- aborting.';
  end if;

  -- Resolve Dave Quiring by his profile full_name, scoped to this org's
  -- membership; hard-stop unless exactly one match.
  select u.id, u.raw_user_meta_data ->> 'full_name'
    into v_dave_id, v_dave_name
  from auth.users u
  join public.memberships m on m.user_id = u.id
  where m.organization_id = v_org_id and u.raw_user_meta_data ->> 'full_name' = 'Dave Quiring';

  if v_dave_id is null then
    raise exception 'No member named "Dave Quiring" found in this organization -- aborting.';
  end if;

  if (select count(*) from auth.users u
      join public.memberships m on m.user_id = u.id
      where m.organization_id = v_org_id and u.raw_user_meta_data ->> 'full_name' = 'Dave Quiring') > 1 then
    raise exception 'More than one member named "Dave Quiring" found -- aborting, resolve ambiguity manually.';
  end if;

  if v_dave_id = v_isaak_id then
    raise exception 'Resolved Dave Quiring to the same account as isaak -- aborting, this should never happen.';
  end if;

  -- Derive initials exactly the way the app does at completion time (see
  -- deriveInitials in server/src/routes/foodSafety/services/actorIdentity.ts):
  -- first + last name initial for a multi-word name, first two letters of a
  -- single-word name.
  v_name_parts := regexp_split_to_array(trim(v_dave_name), '\s+');
  if array_length(v_name_parts, 1) = 1 then
    v_dave_initials := upper(left(v_name_parts[1], 2));
  else
    v_dave_initials := upper(left(v_name_parts[1], 1) || left(v_name_parts[array_length(v_name_parts, 1)], 1));
  end if;

  raise notice 'Location id: %', v_location_id;
  raise notice 'isaak user id: %', v_isaak_id;
  raise notice 'Dave Quiring user id: % (name=% initials=%)', v_dave_id, v_dave_name, v_dave_initials;

  insert into exterior_attribution_fix_summary values ('location_id', v_location_id::text, 1);
  insert into exterior_attribution_fix_summary values ('isaak_user_id', v_isaak_id::text, 1);
  insert into exterior_attribution_fix_summary values ('dave_user_id', v_dave_id::text || ' (' || v_dave_name || ', ' || v_dave_initials || ')', 1);

  -- Disable the immutability triggers for the duration of this transaction
  -- only. A rollback (any RAISE EXCEPTION above or below) undoes this too.
  alter table public.food_safety_cleaning_reports disable trigger food_safety_cleaning_reports_immutable;
  alter table public.food_safety_cleaning_report_items disable trigger food_safety_cleaning_report_items_immutable;

  -- Reports: only this location, only rows currently attributed to isaak.
  -- completed_at and every other column untouched.
  update public.food_safety_cleaning_reports
  set completed_by_user_id = v_dave_id,
      completed_by_name = v_dave_name,
      completed_by_initials = v_dave_initials
  where location_id = v_location_id
    and completed_by_user_id = v_isaak_id;
  get diagnostics v_reports_updated = row_count;
  insert into exterior_attribution_fix_summary values ('reports_updated', 'food_safety_cleaning_reports', v_reports_updated);

  -- Report items: only items belonging to the reports just updated, and
  -- only where the item itself was attributed to isaak (an item with a null
  -- checked_by_user_id -- i.e. never checked -- is left null, not attributed
  -- to anyone). response_value, checked_at, and every other column untouched.
  update public.food_safety_cleaning_report_items
  set checked_by_user_id = v_dave_id,
      checked_by_name = v_dave_name,
      checked_by_initials = v_dave_initials
  where checked_by_user_id = v_isaak_id
    and report_id in (
      select id from public.food_safety_cleaning_reports where location_id = v_location_id
    );
  get diagnostics v_items_updated = row_count;
  insert into exterior_attribution_fix_summary values ('report_items_updated', 'food_safety_cleaning_report_items', v_items_updated);

  -- Re-enable the safeguard before commit.
  alter table public.food_safety_cleaning_report_items enable trigger food_safety_cleaning_report_items_immutable;
  alter table public.food_safety_cleaning_reports enable trigger food_safety_cleaning_reports_immutable;
end $$;

-- Prints the full summary as a result set (visible in the Supabase SQL
-- editor's results grid, not just the log/notices panel).
select * from exterior_attribution_fix_summary order by step;

commit;


-- =========================================================================
-- STEP 3 -- VERIFICATION (read-only). Run after Step 2 commits.
-- =========================================================================

-- Every report at this location should now show Dave Quiring, and nothing
-- else about the rows (dates, task answers) should look different from
-- Step 1's preview.
select id as report_id, completed_at, completed_by_name, completed_by_initials, completed_by_user_id
from public.food_safety_cleaning_reports r
join public.food_safety_cleaning_locations l on l.id = r.location_id
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and l.name = 'Exterior Premises Inspection - Monthly'
order by completed_at;
-- Expect: completed_by_name = 'Dave Quiring', completed_by_initials = 'DQ'
-- on every row; completed_at values identical to Step 1's preview.

-- No isaak-attributed report should remain at this location.
select count(*) as isaak_reports_remaining_here
from public.food_safety_cleaning_reports r
join public.food_safety_cleaning_locations l on l.id = r.location_id
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and l.name = 'Exterior Premises Inspection - Monthly'
  and r.completed_by_name = 'isaak';
-- Expect: 0.

-- isaak's reports at every OTHER location must be exactly what Step 1's
-- sanity check showed (Packing Line / Packing Area.: 72, Washroom 2: 1) --
-- unchanged by this script.
select l.name as location_name, count(*) as isaak_report_count
from public.food_safety_cleaning_reports r
join public.food_safety_cleaning_locations l on l.id = r.location_id
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and r.completed_by_name = 'isaak'
group by l.name
order by l.name;
-- Expect: "Exterior Premises Inspection - Monthly" absent from this list
-- (0 rows), every other location's count unchanged from Step 1.

-- Dave Quiring should now appear ONLY at this location (he had zero
-- reports anywhere before this script ran).
select l.name as location_name, count(*) as dave_report_count
from public.food_safety_cleaning_reports r
join public.food_safety_cleaning_locations l on l.id = r.location_id
join public.organizations o on o.id = l.organization_id
where o.name = 'First Light Greenhouses inc'
  and r.completed_by_name = 'Dave Quiring'
group by l.name
order by l.name;
-- Expect: exactly one row, "Exterior Premises Inspection - Monthly".

-- No orphaned/mismatched report_items: every item now attributed to Dave
-- must belong to a report that is itself now attributed to Dave at this
-- location (catches any item incorrectly updated outside the report set).
select ri.id, ri.report_id, r.location_id
from public.food_safety_cleaning_report_items ri
join public.food_safety_cleaning_reports r on r.id = ri.report_id
where ri.checked_by_name = 'Dave Quiring'
  and r.location_id <> (
    select l.id from public.food_safety_cleaning_locations l
    join public.organizations o on o.id = l.organization_id
    where o.name = 'First Light Greenhouses inc' and l.name = 'Exterior Premises Inspection - Monthly'
  );
-- Expect: no rows.

-- Both immutability triggers must be back on.
select tgname, tgenabled
from pg_trigger
where tgname in ('food_safety_cleaning_reports_immutable', 'food_safety_cleaning_report_items_immutable');
-- Expect: two rows, tgenabled = 'O' (enabled) for both.
