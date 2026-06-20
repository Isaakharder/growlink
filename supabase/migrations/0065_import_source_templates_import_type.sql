-- Migration 0065: add import_type to import_source_templates
--
-- 'yield_kg'        covers the existing generic CSV lot/yield mapping wizard
--                   (AWETA/packline exports). All existing templates get this
--                   default, so existing behaviour is unchanged.
-- 'weather_station' covers key/value weather station CSV exports (e.g. Ridder
--                   Synopta) where the timestamp is embedded in the filename
--                   and parsed metrics land in climate_imports + climate_readings
--                   + daily_light_logs, identical to the Windows Climate Agent.
--
-- DEFAULT 'yield_kg' means every existing template row needs no backfill.

ALTER TABLE public.import_source_templates
  ADD COLUMN import_type text NOT NULL DEFAULT 'yield_kg'
  CHECK (import_type IN ('yield_kg', 'weather_station'));
