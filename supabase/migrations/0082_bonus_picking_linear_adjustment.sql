-- Replaces Picking's multiplier-point adjustment with a configurable linear
-- (absolute kg/hr) threshold adjustment. Winding/Pruning keeps its existing
-- multiplier-curve + workload-level system unchanged.
--
-- adjusted threshold = base threshold + clamp(
--   ((weekly crop load - standard crop load) / crop load step) * speed change per step,
--   minimum adjustment, maximum adjustment
-- )

alter table public.quality_bonus_adjustment_settings
  add column if not exists standard_crop_load     numeric,
  add column if not exists crop_load_step         numeric,
  add column if not exists speed_change_per_step   numeric,
  add column if not exists min_adjustment          numeric,
  add column if not exists max_adjustment          numeric;

-- Historical calculation inputs for Picking's linear adjustment, saved on
-- every bonus record so editing Setup later never changes past bonuses.
alter table public.quality_bonus_entries
  add column if not exists standard_crop_load_used     numeric,
  add column if not exists crop_load_step_used          numeric,
  add column if not exists speed_change_per_step_used   numeric,
  add column if not exists min_adjustment_used           numeric,
  add column if not exists max_adjustment_used           numeric,
  add column if not exists raw_adjustment                numeric,
  add column if not exists final_adjustment               numeric;

-- Picking no longer uses the interpolated crop_load multiplier curve —
-- remove now-orphaned points. Winding/Pruning's sets_per_plant axis is
-- untouched.
delete from public.quality_bonus_multiplier_points
  where check_type = 'picking_peppers' and axis = 'crop_load';
