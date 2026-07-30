-- Reset the Calibration module's old schema before recreating it.
--
-- Hosted Supabase had an earlier version of migrations 0103/0104 pushed
-- (with pest_calibration_devices.category/location instead of
-- area/notes/instructions, no placeholder/value_choices columns, and an
-- older pest_calibration_complete_record signature with no
-- completion_request_id). Those two files were then edited in place
-- several more times afterward (a Food-Safety-style redesign, then a
-- field-editor rework) under the mistaken assumption that they hadn't been
-- deployed anywhere yet.
--
-- Supabase's migration tracking records a version (e.g. "0103") as applied
-- by its number alone, not by file content — so hosted, having already
-- recorded 0103/0104 as applied, will never re-run them again no matter how
-- their content changes. This migration removes the old, since-superseded
-- objects so 0106/0107 (verbatim copies of 0103/0104's current content) can
-- create the up-to-date shape from a clean slate.
--
-- Confirmed safe immediately before writing this: every pest_calibration_*
-- table was completely empty, across every organization.
--
-- 0103/0104 are left untouched in this repo as the historical record of
-- what was actually applied where; no migration is ever edited or
-- renumbered after the fact again — this file is the correction instead.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('pest_calibration_complete_record', 'pest_calibration_prevent_mutation')
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

drop table if exists public.pest_calibration_record_repeating_answers cascade;
drop table if exists public.pest_calibration_record_repeating_rows cascade;
drop table if exists public.pest_calibration_record_answers cascade;
drop table if exists public.pest_calibration_records cascade;
drop table if exists public.pest_calibration_template_fields cascade;
drop table if exists public.pest_calibration_templates cascade;
drop table if exists public.pest_calibration_device_instructions cascade;
drop table if exists public.pest_calibration_devices cascade;
