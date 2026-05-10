-- Migration 0019: Enforce organization isolation via RLS
--
-- Replaces all using (true) / with check (true) policies with
-- membership-gated policies. Adds a SECURITY DEFINER helper function
-- so org-scoped table policies can check memberships without causing
-- recursive RLS evaluation on the memberships table itself.
--
-- Server routes use the service role key, which bypasses RLS entirely,
-- so no Express/DockLink routes are affected by this migration.

-- ============================================================
-- SECTION 1: Helper function
-- ============================================================

-- is_org_member reads memberships with SECURITY DEFINER so it
-- bypasses RLS on that table. This prevents infinite recursion
-- when memberships itself has an RLS policy.
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships
    where organization_id = org_id
      and user_id = auth.uid()
  );
$$;

grant execute on function public.is_org_member(uuid) to authenticated;

-- ============================================================
-- SECTION 2: organizations
-- ============================================================

drop policy if exists organizations_select_all on public.organizations;
drop policy if exists organizations_insert_all on public.organizations;
drop policy if exists organizations_update_all on public.organizations;
drop policy if exists organizations_delete_all on public.organizations;

-- Authenticated users see only their own org
create policy organizations_select_member on public.organizations
  for select
  to authenticated
  using (public.is_org_member(id));

-- INSERT / UPDATE / DELETE: no authenticated policy → default deny.
-- Org creation and management is handled server-side via service role.

-- ============================================================
-- SECTION 3: memberships
-- ============================================================

drop policy if exists memberships_select_all on public.memberships;
drop policy if exists memberships_insert_all on public.memberships;
drop policy if exists memberships_update_all on public.memberships;
drop policy if exists memberships_delete_all on public.memberships;

-- Users can see only their own membership row.
-- Deliberately does NOT call is_org_member() here to avoid any
-- chance of recursive evaluation.
create policy memberships_select_own on public.memberships
  for select
  to authenticated
  using (user_id = auth.uid());

-- INSERT / UPDATE / DELETE: no authenticated policy → default deny.
-- Membership management is handled server-side via service role.

-- ============================================================
-- SECTION 4: varieties  (RLS was never enabled — enable it now)
-- ============================================================

alter table public.varieties enable row level security;

drop policy if exists varieties_select_all on public.varieties;
drop policy if exists varieties_insert_all on public.varieties;
drop policy if exists varieties_update_all on public.varieties;
drop policy if exists varieties_delete_all on public.varieties;

create policy varieties_select_org on public.varieties
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy varieties_insert_org on public.varieties
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy varieties_update_org on public.varieties
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy varieties_delete_org on public.varieties
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 5: yield_sizes
-- ============================================================

drop policy if exists yield_sizes_select_all on public.yield_sizes;
drop policy if exists yield_sizes_insert_all on public.yield_sizes;
drop policy if exists yield_sizes_update_all on public.yield_sizes;
drop policy if exists yield_sizes_delete_all on public.yield_sizes;

create policy yield_sizes_select_org on public.yield_sizes
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy yield_sizes_insert_org on public.yield_sizes
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy yield_sizes_update_org on public.yield_sizes
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy yield_sizes_delete_org on public.yield_sizes
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 6: yield_entries
-- ============================================================

drop policy if exists yield_entries_select_all on public.yield_entries;
drop policy if exists yield_entries_insert_all on public.yield_entries;
drop policy if exists yield_entries_update_all on public.yield_entries;
drop policy if exists yield_entries_delete_all on public.yield_entries;

create policy yield_entries_select_org on public.yield_entries
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy yield_entries_insert_org on public.yield_entries
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy yield_entries_update_org on public.yield_entries
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy yield_entries_delete_org on public.yield_entries
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 7: greenhouse_groups
-- ============================================================

drop policy if exists greenhouse_groups_select_all on public.greenhouse_groups;
drop policy if exists greenhouse_groups_insert_all on public.greenhouse_groups;
drop policy if exists greenhouse_groups_update_all on public.greenhouse_groups;
drop policy if exists greenhouse_groups_delete_all on public.greenhouse_groups;

create policy greenhouse_groups_select_org on public.greenhouse_groups
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy greenhouse_groups_insert_org on public.greenhouse_groups
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy greenhouse_groups_update_org on public.greenhouse_groups
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy greenhouse_groups_delete_org on public.greenhouse_groups
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 8: greenhouse_row_sections
-- ============================================================

drop policy if exists greenhouse_row_sections_select_all on public.greenhouse_row_sections;
drop policy if exists greenhouse_row_sections_insert_all on public.greenhouse_row_sections;
drop policy if exists greenhouse_row_sections_update_all on public.greenhouse_row_sections;
drop policy if exists greenhouse_row_sections_delete_all on public.greenhouse_row_sections;

create policy greenhouse_row_sections_select_org on public.greenhouse_row_sections
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy greenhouse_row_sections_insert_org on public.greenhouse_row_sections
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy greenhouse_row_sections_update_org on public.greenhouse_row_sections
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy greenhouse_row_sections_delete_org on public.greenhouse_row_sections
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 9: greenhouse_rows
-- ============================================================

drop policy if exists greenhouse_rows_select_all on public.greenhouse_rows;
drop policy if exists greenhouse_rows_insert_all on public.greenhouse_rows;
drop policy if exists greenhouse_rows_update_all on public.greenhouse_rows;
drop policy if exists greenhouse_rows_delete_all on public.greenhouse_rows;

create policy greenhouse_rows_select_org on public.greenhouse_rows
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy greenhouse_rows_insert_org on public.greenhouse_rows
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy greenhouse_rows_update_org on public.greenhouse_rows
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy greenhouse_rows_delete_org on public.greenhouse_rows
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 10: greenhouse_variety_assignments
-- ============================================================

drop policy if exists greenhouse_assignments_select_all on public.greenhouse_variety_assignments;
drop policy if exists greenhouse_assignments_insert_all on public.greenhouse_variety_assignments;
drop policy if exists greenhouse_assignments_update_all on public.greenhouse_variety_assignments;
drop policy if exists greenhouse_assignments_delete_all on public.greenhouse_variety_assignments;

create policy greenhouse_assignments_select_org on public.greenhouse_variety_assignments
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy greenhouse_assignments_insert_org on public.greenhouse_variety_assignments
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy greenhouse_assignments_update_org on public.greenhouse_variety_assignments
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy greenhouse_assignments_delete_org on public.greenhouse_variety_assignments
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 11: irrigation_groups
-- ============================================================

drop policy if exists irrigation_groups_select_all on public.irrigation_groups;
drop policy if exists irrigation_groups_insert_all on public.irrigation_groups;
drop policy if exists irrigation_groups_update_all on public.irrigation_groups;
drop policy if exists irrigation_groups_delete_all on public.irrigation_groups;

create policy irrigation_groups_select_org on public.irrigation_groups
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy irrigation_groups_insert_org on public.irrigation_groups
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy irrigation_groups_update_org on public.irrigation_groups
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy irrigation_groups_delete_org on public.irrigation_groups
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 12: irrigation_feed_valves
-- ============================================================

drop policy if exists irrigation_feed_valves_select_all on public.irrigation_feed_valves;
drop policy if exists irrigation_feed_valves_insert_all on public.irrigation_feed_valves;
drop policy if exists irrigation_feed_valves_update_all on public.irrigation_feed_valves;
drop policy if exists irrigation_feed_valves_delete_all on public.irrigation_feed_valves;

create policy irrigation_feed_valves_select_org on public.irrigation_feed_valves
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy irrigation_feed_valves_insert_org on public.irrigation_feed_valves
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy irrigation_feed_valves_update_org on public.irrigation_feed_valves
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy irrigation_feed_valves_delete_org on public.irrigation_feed_valves
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 13: irrigation_drain_buckets
-- ============================================================

drop policy if exists irrigation_drain_buckets_select_all on public.irrigation_drain_buckets;
drop policy if exists irrigation_drain_buckets_insert_all on public.irrigation_drain_buckets;
drop policy if exists irrigation_drain_buckets_update_all on public.irrigation_drain_buckets;
drop policy if exists irrigation_drain_buckets_delete_all on public.irrigation_drain_buckets;

create policy irrigation_drain_buckets_select_org on public.irrigation_drain_buckets
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy irrigation_drain_buckets_insert_org on public.irrigation_drain_buckets
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy irrigation_drain_buckets_update_org on public.irrigation_drain_buckets
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy irrigation_drain_buckets_delete_org on public.irrigation_drain_buckets
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 14: mobile_irrigation_logs
-- ============================================================

drop policy if exists mobile_irrigation_logs_select_all on public.mobile_irrigation_logs;
drop policy if exists mobile_irrigation_logs_insert_all on public.mobile_irrigation_logs;
drop policy if exists mobile_irrigation_logs_update_all on public.mobile_irrigation_logs;
drop policy if exists mobile_irrigation_logs_delete_all on public.mobile_irrigation_logs;

create policy mobile_irrigation_logs_select_org on public.mobile_irrigation_logs
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy mobile_irrigation_logs_insert_org on public.mobile_irrigation_logs
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy mobile_irrigation_logs_update_org on public.mobile_irrigation_logs
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy mobile_irrigation_logs_delete_org on public.mobile_irrigation_logs
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 15: color_case_entries
-- ============================================================

drop policy if exists color_case_entries_select_all on public.color_case_entries;
drop policy if exists color_case_entries_insert_all on public.color_case_entries;
drop policy if exists color_case_entries_update_all on public.color_case_entries;
drop policy if exists color_case_entries_delete_all on public.color_case_entries;

create policy color_case_entries_select_org on public.color_case_entries
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy color_case_entries_insert_org on public.color_case_entries
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy color_case_entries_update_org on public.color_case_entries
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy color_case_entries_delete_org on public.color_case_entries
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 16: organization_integrations
-- ============================================================

drop policy if exists organization_integrations_select_all on public.organization_integrations;
drop policy if exists organization_integrations_insert_all on public.organization_integrations;
drop policy if exists organization_integrations_update_all on public.organization_integrations;
drop policy if exists organization_integrations_delete_all on public.organization_integrations;

-- Read-only for authenticated members. Writes are server-side only
-- (DockLink sync uses service role key which bypasses RLS).
create policy organization_integrations_select_org on public.organization_integrations
  for select
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 17: daily_yield_bin_settings
-- ============================================================

drop policy if exists daily_yield_bin_settings_select_all on public.daily_yield_bin_settings;
drop policy if exists daily_yield_bin_settings_insert_all on public.daily_yield_bin_settings;
drop policy if exists daily_yield_bin_settings_update_all on public.daily_yield_bin_settings;
drop policy if exists daily_yield_bin_settings_delete_all on public.daily_yield_bin_settings;

create policy daily_yield_bin_settings_select_org on public.daily_yield_bin_settings
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy daily_yield_bin_settings_insert_org on public.daily_yield_bin_settings
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy daily_yield_bin_settings_update_org on public.daily_yield_bin_settings
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy daily_yield_bin_settings_delete_org on public.daily_yield_bin_settings
  for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- ============================================================
-- SECTION 18: daily_yield_samples
-- ============================================================

drop policy if exists daily_yield_samples_select_all on public.daily_yield_samples;
drop policy if exists daily_yield_samples_insert_all on public.daily_yield_samples;
drop policy if exists daily_yield_samples_update_all on public.daily_yield_samples;
drop policy if exists daily_yield_samples_delete_all on public.daily_yield_samples;

create policy daily_yield_samples_select_org on public.daily_yield_samples
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy daily_yield_samples_insert_org on public.daily_yield_samples
  for insert
  to authenticated
  with check (public.is_org_member(organization_id));

create policy daily_yield_samples_update_org on public.daily_yield_samples
  for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy daily_yield_samples_delete_org on public.daily_yield_samples
  for delete
  to authenticated
  using (public.is_org_member(organization_id));
