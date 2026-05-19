-- Migration 0036: Add picking_bin_kg and case_kg to daily_yield_bin_settings.
-- These store org-level projection defaults managed via Greenhouse Setup.
-- Using the existing org-scoped table avoids a new table and new RLS policies.

alter table public.daily_yield_bin_settings
  add column if not exists picking_bin_kg numeric,
  add column if not exists case_kg numeric;
