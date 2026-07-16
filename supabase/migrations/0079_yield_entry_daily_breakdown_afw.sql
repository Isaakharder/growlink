-- Preserve the average fruit weight for each individual packing day, not just
-- the weekly yield_entries rollup. Without this, per-submission AFW is only
-- ever kept as a weighted average on the weekly row and the day-specific
-- value is lost once a later submission updates that average.

alter table public.yield_entry_daily_breakdown
  add column if not exists average_fruit_weight_g numeric;

grant select, insert, update, delete on table public.yield_entry_daily_breakdown to service_role;
