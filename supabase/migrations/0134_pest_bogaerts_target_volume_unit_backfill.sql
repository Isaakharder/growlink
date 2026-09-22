-- Bogaerts Qii-Jet Target Spray Volume now supports a unit selector
-- (L/acre or imp_gal_per_acre — Imperial gallons, confirmed directly from
-- the robot's own display: 1 Imperial gal = 4.54609 L, NOT US gal =
-- 3.785411784 L). Every job snapshot now records both the raw entered
-- value/unit (target_volume_value / target_volume_unit) and the normalized
-- target_volume_l_per_acre actually used in the calculation.
--
-- Existing rows only ever recorded target_volume_l_per_acre, and that field
-- name has always meant liters per acre (never gallons) — its meaning does
-- not change. This migration is purely additive: it backfills
-- target_volume_unit = 'L_per_acre' and target_volume_value = the existing
-- target_volume_l_per_acre figure, so older jobs are just as explicit about
-- their unit as new ones. It never touches target_volume_l_per_acre itself,
-- so no existing value is reinterpreted.

update public.pest_control_todos
set sprayer_snapshot = sprayer_snapshot
  || jsonb_build_object(
       'target_volume_unit', 'L_per_acre',
       'target_volume_value', sprayer_snapshot->'target_volume_l_per_acre'
     )
where sprayer_snapshot->>'method' = 'bogaerts'
  and sprayer_snapshot ? 'target_volume_l_per_acre'
  and not (sprayer_snapshot ? 'target_volume_unit');

update public.pest_control_todos
set calculation_snapshot = calculation_snapshot
  || jsonb_build_object(
       'target_volume_unit', 'L_per_acre',
       'target_volume_value', calculation_snapshot->'target_volume_l_per_acre'
     )
where calculation_snapshot->>'method' = 'bogaerts'
  and calculation_snapshot ? 'target_volume_l_per_acre'
  and not (calculation_snapshot ? 'target_volume_unit');

update public.pest_control_records
set sprayer_snapshot = sprayer_snapshot
  || jsonb_build_object(
       'target_volume_unit', 'L_per_acre',
       'target_volume_value', sprayer_snapshot->'target_volume_l_per_acre'
     )
where sprayer_snapshot->>'method' = 'bogaerts'
  and sprayer_snapshot ? 'target_volume_l_per_acre'
  and not (sprayer_snapshot ? 'target_volume_unit');

update public.pest_control_records
set calculation_snapshot = calculation_snapshot
  || jsonb_build_object(
       'target_volume_unit', 'L_per_acre',
       'target_volume_value', calculation_snapshot->'target_volume_l_per_acre'
     )
where calculation_snapshot->>'method' = 'bogaerts'
  and calculation_snapshot ? 'target_volume_l_per_acre'
  and not (calculation_snapshot ? 'target_volume_unit');
