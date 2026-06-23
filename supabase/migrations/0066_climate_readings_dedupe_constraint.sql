-- Migration 0066: promote climate_readings unique index to a named constraint
--
-- PostgREST's upsert(onConflict: col_list) requires the conflict target to be
-- a UNIQUE CONSTRAINT, not merely a unique index. Migration 0055 created only
-- CREATE UNIQUE INDEX climate_readings_dedupe_idx, so every weather-station
-- upsert silently failed with "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification". The index is promoted here using
-- UNIQUE USING INDEX, which re-uses the existing b-tree without rebuilding it.

ALTER TABLE public.climate_readings
  ADD CONSTRAINT climate_readings_dedupe
  UNIQUE USING INDEX climate_readings_dedupe_idx;
