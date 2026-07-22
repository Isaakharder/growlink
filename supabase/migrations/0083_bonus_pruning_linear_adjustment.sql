-- Generalizes Picking's linear adjustment columns for reuse by Winding/Pruning
-- too, since both jobs now use the same additive threshold-adjustment
-- mechanism (Picking: weekly kg/m^2 -> kg/hr offset; Winding/Pruning: weekly
-- fruit sets/m^2 -> heads/hr offset). Renamed to job-agnostic names since a
-- single settings row per (organization_id, check_type) already scopes them
-- per job — "standard_crop_load" was misleading once Pruning reused the
-- same column for "standard fruit sets/m^2".

alter table public.quality_bonus_adjustment_settings
  rename column standard_crop_load to standard_value;
alter table public.quality_bonus_adjustment_settings
  rename column crop_load_step to value_step;

alter table public.quality_bonus_entries
  rename column standard_crop_load_used to standard_value_used;
alter table public.quality_bonus_entries
  rename column crop_load_step_used to value_step_used;

-- Winding/Pruning no longer uses the interpolated sets-per-plant multiplier
-- curve or the pruning-workload multiplier — both are replaced by the linear
-- heads/hr adjustment above. Remove now-orphaned configuration (mirrors the
-- Picking crop_load cleanup in 0082).
delete from public.quality_bonus_multiplier_points
  where check_type = 'winding_pruning' and axis = 'sets_per_plant';
delete from public.quality_bonus_workload_levels
  where check_type = 'winding_pruning';
