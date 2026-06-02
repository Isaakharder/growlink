-- Widen the yield_projections week constraint from 1–52 to 1–53.
-- ISO years can have 53 weeks (e.g. 2020, 2026). The original constraint was too narrow.

alter table public.yield_projections
  drop constraint if exists yield_projections_week_check;

alter table public.yield_projections
  add constraint yield_projections_week_check
  check (week between 1 and 53);
