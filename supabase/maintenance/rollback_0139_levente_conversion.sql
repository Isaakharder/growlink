-- rollback_0139_levente_conversion.sql
--
-- Undoes migration 0139 (legacy Levente -> Levente Phase 2 / Phase 3) from
-- the rows it recorded in variety_conversion_rows. Run by hand only if the
-- conversion must be reversed. One DO block: any failed check rolls back all.
--
-- 1. Deletes the generated Phase 2/3 entries and daily breakdowns (by the
--    ids the conversion recorded - never by week or variety).
-- 2. Re-inserts the original legacy entries and breakdowns with their
--    original ids and every original column value.
-- 3. Retags the daily yield samples back to the legacy variety.
-- 4. Restores the legacy variety row (status, updated_at).
-- 5. Removes the backup rows and the marker, so 0139 could be applied again.
-- It refuses to run if a generated row was edited after the conversion
-- (its total no longer matches), so later corrections are never lost.

do $$
declare
  k           constant text := 'first-light-2026-legacy-levente';
  v_legacy    constant uuid := 'd8f19f12-4b1b-4a14-b5b7-9aa3894478a1';
  v_farm_before numeric;
  v_n         integer;
begin
  if not exists (select 1 from public.variety_conversions where conversion_key = k) then
    raise exception 'rollback 0139: conversion % is not applied', k;
  end if;
  v_farm_before := (select (summary ->> 'farm_2026_kg_before')::numeric from public.variety_conversions where conversion_key = k);

  -- Generated entries must be exactly as the conversion wrote them.
  select count(*) into v_n
    from public.variety_conversion_rows r
   where r.conversion_key = k and r.role = 'generated' and r.table_name = 'yield_entries'
     and not exists (select 1 from public.yield_entries e where e.id = r.row_id);
  if v_n > 0 then
    raise exception 'rollback 0139: % generated entries no longer exist; restore by hand', v_n;
  end if;
  if exists (
    select 1 from public.yield_entries e
      join public.variety_conversion_rows r on r.row_id = e.id and r.conversion_key = k and r.role = 'generated' and r.table_name = 'yield_entries'
     where e.updated_at > (select applied_at from public.variety_conversions where conversion_key = k) + interval '1 minute'
  ) then
    raise exception 'rollback 0139: a generated entry was edited after the conversion; reconcile it by hand';
  end if;

  delete from public.yield_entry_daily_breakdown
   where id in (select row_id from public.variety_conversion_rows where conversion_key = k and role = 'generated' and table_name = 'yield_entry_daily_breakdown');
  delete from public.yield_entries
   where id in (select row_id from public.variety_conversion_rows where conversion_key = k and role = 'generated' and table_name = 'yield_entries');

  insert into public.yield_entries
  select (jsonb_populate_record(null::public.yield_entries, r.row_data)).*
    from public.variety_conversion_rows r
   where r.conversion_key = k and r.role = 'original' and r.table_name = 'yield_entries';

  insert into public.yield_entry_daily_breakdown
  select (jsonb_populate_record(null::public.yield_entry_daily_breakdown, r.row_data)).*
    from public.variety_conversion_rows r
   where r.conversion_key = k and r.role = 'original' and r.table_name = 'yield_entry_daily_breakdown';

  update public.daily_yield_samples s
     set variety_id = (r.row_data ->> 'variety_id')::uuid
    from public.variety_conversion_rows r
   where r.conversion_key = k and r.role = 'original' and r.table_name = 'daily_yield_samples' and r.row_id = s.id;

  update public.varieties v
     set status = r.row_data ->> 'status', updated_at = (r.row_data ->> 'updated_at')::timestamptz
    from public.variety_conversion_rows r
   where r.conversion_key = k and r.role = 'original' and r.table_name = 'varieties' and r.row_id = v.id;

  if (select coalesce(sum(total_kg), 0) from public.yield_entries
       where organization_id = (select organization_id from public.variety_conversions where conversion_key = k) and year = 2026) <> v_farm_before then
    raise exception 'rollback 0139: 2026 farm total did not return to %', v_farm_before;
  end if;
  if (select coalesce(sum(total_kg), 0) from public.yield_entries where variety_id = v_legacy) <> 188649 then
    raise exception 'rollback 0139: legacy Levente did not return to 188,649 kg';
  end if;

  delete from public.variety_conversion_rows where conversion_key = k;
  delete from public.variety_conversions where conversion_key = k;
end $$;
