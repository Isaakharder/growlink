-- ============================================================
-- GrowLink Database Duplicate Audit
-- File: supabase/audits/check_duplicate_org_rows.sql
--
-- Purpose:
--   Identify rows that violate natural-key uniqueness at the
--   org-scoped level before any formal unique constraints are
--   added. Run this first; decide on cleanup based on results.
--
-- Constraint history from migrations:
--   0008  greenhouse_rows            (group_id, row_number)
--             → dedup DELETE ran before constraint was added
--   0018  mobile_irrigation_logs     (organization_id, log_date, group_key)
--             → old (log_date, group_key) constraint dropped first;
--               no explicit dedup step — relied on prior constraint
--   0018  color_case_entries         (organization_id, color, year, week)
--             → explicit dedup DELETE ran before constraint was added
--
--   All other tables: organization_id was added in 0018 as NOT NULL
--   but with NO org-scoped unique constraint and NO dedup step.
--   These are the highest risk tables.
--
-- Safety: Read-only. No DELETE, UPDATE, or DDL statements.
--         Safe to run against production with any SELECT role.
--
-- How to read results:
--   Each query returns rows only where duplicates exist.
--   Empty result = clean. Non-empty = needs cleanup before
--   a unique constraint can be added safely.
--
-- Next step after audit:
--   If duplicates exist, open a separate cleanup migration.
--   Then add formal unique constraints.
-- ============================================================


-- ============================================================
-- SECTION 1: varieties
-- Natural key: (organization_id, name)
-- Constraint status: NONE
-- Risk: Same variety name entered more than once for the same
--       org. Breaks UI dropdowns (two "Tomato" options) and
--       causes double-counting in yield analytics.
-- ============================================================
SELECT
  'varieties'                                          AS table_name,
  organization_id,
  name                                                 AS dup_key_name,
  NULL::text                                           AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.varieties
GROUP BY organization_id, name
HAVING count(*) > 1
ORDER BY organization_id, name;


-- ============================================================
-- SECTION 2: yield_sizes
-- Natural key: (organization_id, name)
-- Constraint status: NONE
-- Risk: Duplicate size labels cause split yield totals and
--       confuse the data-entry size picker.
-- ============================================================
SELECT
  'yield_sizes'                                        AS table_name,
  organization_id,
  name                                                 AS dup_key_name,
  NULL::text                                           AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.yield_sizes
GROUP BY organization_id, name
HAVING count(*) > 1
ORDER BY organization_id, name;


-- ============================================================
-- SECTION 3: yield_entries
-- Natural key: (organization_id, variety_id, year, week)
-- Constraint status: NONE
-- Risk: Two yield records for the same variety + week cause
--       double-counting in analytics. The upsert path in the
--       server relies on this being unique to update in-place.
-- ============================================================
SELECT
  'yield_entries'                                      AS table_name,
  ye.organization_id,
  v.name                                               AS dup_key_name,
  (ye.year::text || ' W' || lpad(ye.week::text, 2, '0')) AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(ye.id    ORDER BY ye.created_at)           AS row_ids,
  min(ye.created_at)                                   AS first_created_at,
  max(ye.updated_at)                                   AS last_updated_at
FROM public.yield_entries ye
LEFT JOIN public.varieties v
  ON v.id = ye.variety_id
GROUP BY ye.organization_id, ye.variety_id, ye.year, ye.week, v.name
HAVING count(*) > 1
ORDER BY ye.organization_id, v.name, ye.year, ye.week;


-- ============================================================
-- SECTION 4: color_case_entries
-- Natural key: (organization_id, color, year, week)
-- Constraint status: ADDED in 0018 — after an explicit DELETE
--   of duplicates using ctid ordering. This query confirms the
--   cleanup was complete (should return zero rows).
-- ============================================================
SELECT
  'color_case_entries'                                 AS table_name,
  organization_id,
  (color || ' ' || year::text || ' W' || lpad(week::text, 2, '0')) AS dup_key_name,
  NULL::text                                           AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.color_case_entries
GROUP BY organization_id, color, year, week
HAVING count(*) > 1
ORDER BY organization_id, color, year, week;


-- ============================================================
-- SECTION 5: greenhouse_groups
-- Natural key: (organization_id, type, name)
-- Constraint status: NONE
-- Risk: Two groups with the same type+name in one org make
--       variety assignment UI ambiguous and break row routing.
-- ============================================================
SELECT
  'greenhouse_groups'                                  AS table_name,
  organization_id,
  name                                                 AS dup_key_name,
  type                                                 AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.greenhouse_groups
GROUP BY organization_id, type, name
HAVING count(*) > 1
ORDER BY organization_id, type, name;


-- ============================================================
-- SECTION 6: greenhouse_row_sections
-- Natural key: (organization_id, group_id, start_row, end_row, row_pattern)
-- Constraint status: NONE
-- Risk: Two sections covering the same row range in the same
--       group cause duplicate row generation (upsert on
--       group_id+row_number masks this but the sections exist).
-- ============================================================
SELECT
  'greenhouse_row_sections'                            AS table_name,
  organization_id,
  (group_id::text)                                     AS dup_key_name,
  (start_row::text || '-' || end_row::text || ' ' || row_pattern) AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.greenhouse_row_sections
GROUP BY organization_id, group_id, start_row, end_row, row_pattern
HAVING count(*) > 1
ORDER BY organization_id, group_id, start_row;


-- ============================================================
-- SECTION 7: greenhouse_rows
-- Natural key: (organization_id, group_id, row_number)
-- Constraint status: (group_id, row_number) UNIQUE exists since
--   0008 — dedup ran before the constraint. This confirms no
--   org-level violation exists (should return zero rows).
-- ============================================================
SELECT
  'greenhouse_rows'                                    AS table_name,
  organization_id,
  (group_id::text)                                     AS dup_key_name,
  row_number::text                                     AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.greenhouse_rows
GROUP BY organization_id, group_id, row_number
HAVING count(*) > 1
ORDER BY organization_id, group_id, row_number;


-- ============================================================
-- SECTION 8: greenhouse_variety_assignments
-- Natural key: (organization_id, group_id, variety_id, start_row, end_row)
-- Constraint status: NONE
-- Risk: A variety assigned to the same row range twice in the
--       same group produces duplicate daily-yield row options.
-- ============================================================
SELECT
  'greenhouse_variety_assignments'                     AS table_name,
  a.organization_id,
  v.name                                               AS dup_key_name,
  (a.group_id::text || ' rows ' || a.start_row::text || '-' || a.end_row::text) AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(a.id     ORDER BY a.created_at)            AS row_ids,
  min(a.created_at)                                    AS first_created_at,
  max(a.updated_at)                                    AS last_updated_at
FROM public.greenhouse_variety_assignments a
LEFT JOIN public.varieties v
  ON v.id = a.variety_id
GROUP BY a.organization_id, a.group_id, a.variety_id, a.start_row, a.end_row, v.name
HAVING count(*) > 1
ORDER BY a.organization_id, v.name, a.group_id, a.start_row;


-- ============================================================
-- SECTION 9: irrigation_groups
-- Natural key: (organization_id, type, name)
-- Constraint status: NONE
-- Risk: Two groups with the same name+type make the mobile
--       irrigation log UI ambiguous.
-- ============================================================
SELECT
  'irrigation_groups'                                  AS table_name,
  organization_id,
  name                                                 AS dup_key_name,
  type                                                 AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.irrigation_groups
GROUP BY organization_id, type, name
HAVING count(*) > 1
ORDER BY organization_id, type, name;


-- ============================================================
-- SECTION 10: irrigation_feed_valves
-- Natural key: (organization_id, group_id, name)
-- Constraint status: NONE
-- Risk: Duplicate valve names within a group make flow-rate
--       aggregation ambiguous in irrigation log reports.
-- ============================================================
SELECT
  'irrigation_feed_valves'                             AS table_name,
  organization_id,
  name                                                 AS dup_key_name,
  group_id::text                                       AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.irrigation_feed_valves
GROUP BY organization_id, group_id, name
HAVING count(*) > 1
ORDER BY organization_id, group_id, name;


-- ============================================================
-- SECTION 11: irrigation_drain_buckets
-- Natural key: (organization_id, group_id, name)
-- Constraint status: NONE
-- Risk: Same as feed valves — duplicate names corrupt
--       drain percentage calculations.
-- ============================================================
SELECT
  'irrigation_drain_buckets'                           AS table_name,
  organization_id,
  name                                                 AS dup_key_name,
  group_id::text                                       AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.irrigation_drain_buckets
GROUP BY organization_id, group_id, name
HAVING count(*) > 1
ORDER BY organization_id, group_id, name;


-- ============================================================
-- SECTION 12: mobile_irrigation_logs
-- Natural key: (organization_id, log_date, group_key)
-- Constraint status: ADDED in 0018 without a prior dedup step.
--   The 0018 migration dropped the old (log_date, group_key)
--   constraint and added the org-scoped version. Since the
--   constraint add would fail on violations, any successful
--   0018 run means the data was clean at that point.
--   This query checks for violations introduced since then.
-- ============================================================
SELECT
  'mobile_irrigation_logs'                             AS table_name,
  organization_id,
  log_date::text                                       AS dup_key_name,
  group_key                                            AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.mobile_irrigation_logs
GROUP BY organization_id, log_date, group_key
HAVING count(*) > 1
ORDER BY organization_id, log_date, group_key;


-- ============================================================
-- SECTION 13: daily_yield_bin_settings
-- Natural key: (organization_id)
-- Constraint status: NONE
-- Notes: The server intentionally queries the single most
--   recent row per org (ORDER BY created_at DESC LIMIT 1).
--   Multiple rows are therefore not data-loss, but they are
--   clutter. More than one row per org = leftover from
--   development or a bug in the update path.
-- ============================================================
SELECT
  'daily_yield_bin_settings'                           AS table_name,
  organization_id,
  'settings rows per org'                              AS dup_key_name,
  NULL::text                                           AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(id       ORDER BY created_at)              AS row_ids,
  min(created_at)                                      AS first_created_at,
  max(updated_at)                                      AS last_updated_at
FROM public.daily_yield_bin_settings
GROUP BY organization_id
HAVING count(*) > 1
ORDER BY organization_id;


-- ============================================================
-- SECTION 14: daily_yield_samples
-- Natural key: approximate — (organization_id, variety_id,
--              row_id, sample_date, percent_full, kg_per_full_bin)
-- Constraint status: NONE
-- Notes: Multiple samples per variety+row+day is intentional
--   (workers sample multiple times). This query only surfaces
--   exact duplicates on all measurement fields, which almost
--   certainly indicate an accidental double-submit.
-- ============================================================
SELECT
  'daily_yield_samples'                                AS table_name,
  s.organization_id,
  v.name                                               AS dup_key_name,
  (s.sample_date::text || ' row ' || s.row_id::text)  AS dup_key_extra,
  count(*)                                             AS duplicate_count,
  array_agg(s.id     ORDER BY s.created_at)            AS row_ids,
  min(s.created_at)                                    AS first_created_at,
  max(s.created_at)                                    AS last_updated_at
FROM public.daily_yield_samples s
LEFT JOIN public.varieties v
  ON v.id = s.variety_id
GROUP BY
  s.organization_id,
  s.variety_id,
  s.row_id,
  s.sample_date,
  s.session_year,
  s.session_week,
  s.percent_full,
  s.kg_per_full_bin,
  s.kg_per_case,
  v.name
HAVING count(*) > 1
ORDER BY s.organization_id, v.name, s.sample_date;


-- ============================================================
-- SUMMARY: quick table-level view of which tables have any
-- duplicates at all. Each row = one table; dup_table_count is
-- how many distinct duplicate groups were found.
--
-- Run this last to get a single-page overview. Zero on every
-- row means the database is clean for all audited keys.
-- ============================================================
SELECT table_name, sum(duplicate_count) AS total_extra_rows, count(*) AS dup_group_count
FROM (

  SELECT 'varieties' AS table_name, count(*) AS duplicate_count
  FROM public.varieties GROUP BY organization_id, name HAVING count(*) > 1

  UNION ALL

  SELECT 'yield_sizes', count(*)
  FROM public.yield_sizes GROUP BY organization_id, name HAVING count(*) > 1

  UNION ALL

  SELECT 'yield_entries', count(*)
  FROM public.yield_entries GROUP BY organization_id, variety_id, year, week HAVING count(*) > 1

  UNION ALL

  SELECT 'color_case_entries', count(*)
  FROM public.color_case_entries GROUP BY organization_id, color, year, week HAVING count(*) > 1

  UNION ALL

  SELECT 'greenhouse_groups', count(*)
  FROM public.greenhouse_groups GROUP BY organization_id, type, name HAVING count(*) > 1

  UNION ALL

  SELECT 'greenhouse_row_sections', count(*)
  FROM public.greenhouse_row_sections GROUP BY organization_id, group_id, start_row, end_row, row_pattern HAVING count(*) > 1

  UNION ALL

  SELECT 'greenhouse_rows', count(*)
  FROM public.greenhouse_rows GROUP BY organization_id, group_id, row_number HAVING count(*) > 1

  UNION ALL

  SELECT 'greenhouse_variety_assignments', count(*)
  FROM public.greenhouse_variety_assignments GROUP BY organization_id, group_id, variety_id, start_row, end_row HAVING count(*) > 1

  UNION ALL

  SELECT 'irrigation_groups', count(*)
  FROM public.irrigation_groups GROUP BY organization_id, type, name HAVING count(*) > 1

  UNION ALL

  SELECT 'irrigation_feed_valves', count(*)
  FROM public.irrigation_feed_valves GROUP BY organization_id, group_id, name HAVING count(*) > 1

  UNION ALL

  SELECT 'irrigation_drain_buckets', count(*)
  FROM public.irrigation_drain_buckets GROUP BY organization_id, group_id, name HAVING count(*) > 1

  UNION ALL

  SELECT 'mobile_irrigation_logs', count(*)
  FROM public.mobile_irrigation_logs GROUP BY organization_id, log_date, group_key HAVING count(*) > 1

  UNION ALL

  SELECT 'daily_yield_bin_settings', count(*)
  FROM public.daily_yield_bin_settings GROUP BY organization_id HAVING count(*) > 1

  UNION ALL

  SELECT 'daily_yield_samples', count(*)
  FROM public.daily_yield_samples
  GROUP BY organization_id, variety_id, row_id, sample_date, session_year, session_week,
           percent_full, kg_per_full_bin, kg_per_case
  HAVING count(*) > 1

) dup_groups
GROUP BY table_name
ORDER BY total_extra_rows DESC, table_name;
