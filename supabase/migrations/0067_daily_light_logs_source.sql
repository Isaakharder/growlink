-- Migration 0067: Add source column to daily_light_logs
--
-- Tracks whether a daily light value was entered manually or written by the
-- Climate Agent import pipeline. NOT NULL with DEFAULT 'manual' so all
-- existing rows are backfilled without a separate UPDATE.

ALTER TABLE public.daily_light_logs
  ADD COLUMN source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'climate_agent'));
