-- Calibration module — remove the "Overall Result" concept entirely.
--
-- The admin decided the automatic/manual overall Pass-Fail computation adds
-- confusion rather than value: employees can already record their own
-- Yes/No or Pass/Fail answers as ordinary task fields (e.g. "Calibration
-- correct? — Yes/No"), and there is no safe generic way to infer a single
-- device-level Pass/Fail out of an arbitrary custom-option field without
-- new per-option metadata the admin explicitly does not want to build.
--
-- This drops the live config columns (overall_result_mode/_field_id) from
-- pest_calibration_templates outright — they're mutable config, not
-- history, so there's nothing to preserve. The three result columns on
-- pest_calibration_records (calculated_result, recorded_result,
-- result_discrepancy) and overall_result_mode_snapshot are historical
-- snapshot data on an IMMUTABLE table — existing rows and their values are
-- left completely untouched. Only the NOT NULL/default is relaxed so the
-- completion RPC can stop populating them for new records going forward.
-- The client and server stop reading/writing/displaying all of these.

alter table public.pest_calibration_templates
  drop column if exists overall_result_field_id;

alter table public.pest_calibration_templates
  drop column if exists overall_result_mode;

alter table public.pest_calibration_records
  alter column overall_result_mode_snapshot drop not null;

alter table public.pest_calibration_records
  alter column calculated_result drop not null;

alter table public.pest_calibration_records
  alter column recorded_result drop not null;

alter table public.pest_calibration_records
  alter column result_discrepancy drop not null,
  alter column result_discrepancy drop default;
