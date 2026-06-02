-- Evolve yield_projections to track forecast lead time.
--
-- New concept: a projection has two week values:
--   target_year / target_week  — the harvest week being predicted
--   forecast_year / forecast_week — the week the prediction was made
--   weeks_out — ISO weeks between forecast and target
--
-- Renaming year/week → target_year/target_week makes the intent explicit.
-- Adding forecast columns lets us store multiple snapshots for the same
-- target week (one per forecast week), enabling lead-time accuracy analysis.
--
-- HISTORICAL NOTE: rows created before this migration have no forecast-week
-- record. They are backfilled with forecast = target, giving weeks_out = 0.
-- Lead-time accuracy for those rows cannot be reconstructed.

-- 1. Rename existing columns to clarify they are the TARGET
alter table public.yield_projections rename column year to target_year;
alter table public.yield_projections rename column week to target_week;

-- 2. Add forecast columns (nullable so the backfill below can run first)
alter table public.yield_projections
  add column if not exists forecast_year int,
  add column if not exists forecast_week int,
  add column if not exists weeks_out     int;

-- 3. Backfill: no forecast history available for pre-migration rows.
--    Set forecast = target so weeks_out = 0 (same-week snapshot).
update public.yield_projections
set
  forecast_year = target_year,
  forecast_week = target_week,
  weeks_out     = 0
where forecast_year is null;

-- 4. Now that all rows are populated, make the columns required
alter table public.yield_projections
  alter column forecast_year set not null,
  alter column forecast_week set not null,
  alter column weeks_out     set not null;

-- 5. Validate forecast_week range (target_week already constrained from 0043/0044)
alter table public.yield_projections
  add constraint yield_projections_forecast_week_check
  check (forecast_week between 1 and 53);

-- 6. Drop old unique indexes — they used target_year/target_week only,
--    so they prevent storing multiple forecasts for the same target week.
drop index if exists yield_projections_variety_uq;
drop index if exists yield_projections_color_uq;

-- 7. New partial unique indexes include both forecast and target coordinates.
--    This allows: (forecast=W23, target=W25) AND (forecast=W24, target=W25)
--    to coexist — critical for multi-lead-time tracking.
create unique index if not exists yield_projections_variety_uq
  on public.yield_projections
  (organization_id, forecast_year, forecast_week, target_year, target_week, variety_id, unit)
  where projection_level = 'variety';

create unique index if not exists yield_projections_color_uq
  on public.yield_projections
  (organization_id, forecast_year, forecast_week, target_year, target_week, color, unit)
  where projection_level = 'color';

-- 8. Index for forecast_year/week queries (future filtering)
create index if not exists yield_projections_forecast_idx
  on public.yield_projections (organization_id, forecast_year, forecast_week);
