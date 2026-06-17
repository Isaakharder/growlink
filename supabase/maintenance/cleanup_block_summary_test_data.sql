-- One-off cleanup: removes block_summary test imports/readings left over
-- from before GrowLink stopped accepting block summary data (that data now
-- belongs to CropLink). Not a migration -- run manually against a specific
-- environment, and only if/when test block_summary rows actually exist.
--
-- Safe to run multiple times; matches nothing once cleaned up.

begin;

delete from public.climate_readings
where import_id in (
  select id from public.climate_imports where file_type = 'block_summary'
);

delete from public.climate_imports
where file_type = 'block_summary';

commit;
