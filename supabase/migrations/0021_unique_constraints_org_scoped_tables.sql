-- Add unique constraints to org-scoped tables that were missing them.
-- Audit (2026-05-10) confirmed zero duplicates in all tables below —
-- safe to constrain without deduplication.

ALTER TABLE public.varieties
  ADD CONSTRAINT varieties_org_name_key
  UNIQUE (organization_id, name);

ALTER TABLE public.yield_sizes
  ADD CONSTRAINT yield_sizes_org_name_key
  UNIQUE (organization_id, name);

-- yield_entries: server upserts rely on this being unique per variety+week.
ALTER TABLE public.yield_entries
  ADD CONSTRAINT yield_entries_org_variety_year_week_key
  UNIQUE (organization_id, variety_id, year, week);

ALTER TABLE public.greenhouse_groups
  ADD CONSTRAINT greenhouse_groups_org_type_name_key
  UNIQUE (organization_id, type, name);

-- Row sections: a row range within a group can only be defined once.
ALTER TABLE public.greenhouse_row_sections
  ADD CONSTRAINT greenhouse_row_sections_org_group_range_key
  UNIQUE (organization_id, group_id, start_row, end_row);

-- Variety assignments: same variety cannot be assigned to the same range twice.
ALTER TABLE public.greenhouse_variety_assignments
  ADD CONSTRAINT greenhouse_variety_assignments_org_group_variety_range_key
  UNIQUE (organization_id, group_id, variety_id, start_row, end_row);

ALTER TABLE public.irrigation_groups
  ADD CONSTRAINT irrigation_groups_org_type_name_key
  UNIQUE (organization_id, type, name);

ALTER TABLE public.irrigation_feed_valves
  ADD CONSTRAINT irrigation_feed_valves_org_group_name_key
  UNIQUE (organization_id, group_id, name);
