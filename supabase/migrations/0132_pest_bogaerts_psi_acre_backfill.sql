-- Bogaerts Qii-Jet spray planner switches from bar/L-per-hectare to
-- PSI/L-per-acre (the robot is actually calibrated and operated in acres and
-- PSI). Existing snapshots on pest_control_todos and pest_control_records
-- were correctly-entered bar / L-per-ha values at the time, so this is a
-- pure unit conversion, never a relabel:
--   psi = bar * 14.5037738
--   L/acre = (L/ha) / 2.4710538147   (1 ha = 2.4710538147 acres)
--
-- Additive and idempotent: only fills pressure_psi / target_volume_l_per_acre
-- when they are not already present, never overwrites, never removes the
-- original pressure_bar / target_volume_l_per_ha (kept for audit). Rows with
-- no Bogaerts data (sprayer_snapshot->>'method' <> 'bogaerts') are untouched.

update public.pest_control_todos
set sprayer_snapshot = sprayer_snapshot
  || jsonb_build_object(
       'pressure_psi',
       (sprayer_snapshot->>'pressure_bar')::numeric * 14.5037738
     )
where sprayer_snapshot->>'method' = 'bogaerts'
  and sprayer_snapshot ? 'pressure_bar'
  and not (sprayer_snapshot ? 'pressure_psi');

update public.pest_control_todos
set sprayer_snapshot = sprayer_snapshot
  || jsonb_build_object(
       'target_volume_l_per_acre',
       (sprayer_snapshot->>'target_volume_l_per_ha')::numeric / 2.4710538147
     )
where sprayer_snapshot->>'method' = 'bogaerts'
  and sprayer_snapshot ? 'target_volume_l_per_ha'
  and not (sprayer_snapshot ? 'target_volume_l_per_acre');

update public.pest_control_todos
set calculation_snapshot = calculation_snapshot
  || jsonb_build_object(
       'target_volume_l_per_acre',
       (calculation_snapshot->>'target_volume_l_per_ha')::numeric / 2.4710538147
     )
where calculation_snapshot->>'method' = 'bogaerts'
  and calculation_snapshot ? 'target_volume_l_per_ha'
  and not (calculation_snapshot ? 'target_volume_l_per_acre');

update public.pest_control_records
set sprayer_snapshot = sprayer_snapshot
  || jsonb_build_object(
       'pressure_psi',
       (sprayer_snapshot->>'pressure_bar')::numeric * 14.5037738
     )
where sprayer_snapshot->>'method' = 'bogaerts'
  and sprayer_snapshot ? 'pressure_bar'
  and not (sprayer_snapshot ? 'pressure_psi');

update public.pest_control_records
set sprayer_snapshot = sprayer_snapshot
  || jsonb_build_object(
       'target_volume_l_per_acre',
       (sprayer_snapshot->>'target_volume_l_per_ha')::numeric / 2.4710538147
     )
where sprayer_snapshot->>'method' = 'bogaerts'
  and sprayer_snapshot ? 'target_volume_l_per_ha'
  and not (sprayer_snapshot ? 'target_volume_l_per_acre');

update public.pest_control_records
set calculation_snapshot = calculation_snapshot
  || jsonb_build_object(
       'target_volume_l_per_acre',
       (calculation_snapshot->>'target_volume_l_per_ha')::numeric / 2.4710538147
     )
where calculation_snapshot->>'method' = 'bogaerts'
  and calculation_snapshot ? 'target_volume_l_per_ha'
  and not (calculation_snapshot ? 'target_volume_l_per_acre');
