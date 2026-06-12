-- When external_variety_id is present the existing UNIQUE constraint on
-- (organization_id, external_variety_id, year, week) prevents duplicates.
-- When external_variety_id is NULL (e.g. a DockLink row whose variety could
-- not be identified, or a manual entry), Postgres allows multiple NULLs under
-- a standard UNIQUE constraint. This partial index closes that gap by
-- enforcing uniqueness on variety_name_snapshot for the null-ID rows.
create unique index if not exists waste_imports_null_id_unique_idx
  on public.waste_imports (organization_id, variety_name_snapshot, year, week)
  where external_variety_id is null;
