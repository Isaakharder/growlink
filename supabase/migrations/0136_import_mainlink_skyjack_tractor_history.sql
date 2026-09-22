-- 0136_import_mainlink_skyjack_tractor_history.sql
--
-- Durable record for the last two MainLink assets imported into the First
-- Light Greenhouses inc organization: the Skyjack scissor lift (SJ-01) and the
-- John Deere lawn tractor (LT-01), plus one historical maintenance entry each.
--
-- These two rows are ALREADY LIVE in production -- they were applied over
-- PostgREST with exactly the values below, and the idempotency proven by three
-- consecutive production runs (2 inserted, then 0, then 0). This migration
-- exists so the repository describes production, and is written so that
-- applying it is a complete no-op against the current database.
--
-- Companion to 0135, which carried the 22 Bogaert greenhouse scissor lifts and
-- their 30 maintenance entries. Together the two migrations account for all 24
-- equipment rows and 32 maintenance entries in First Light.
--
-- MainLink's two golf carts (GC-16, GC-2034) are deliberately NOT imported.
--
-- SETUP RECORDS ARE RESOLVED, NEVER CREATED. The categories "SkyJacks" and
-- "Outdoor Equipment" and the locations "Boiler/Maintenance Room" and
-- "Outdoor Equipment" were created by hand in the app. This migration matches
-- them on the exact name, including capitalization -- not on name_normalized --
-- and aborts if any one of them is missing or ambiguous. It never inserts,
-- renames or deletes a category or a location.
--
-- IDEMPOTENT BY CONSTRUCTION -- a re-run inserts nothing and updates nothing:
--   * equipment -> on conflict on constraint
--                  maintenance_equipment_org_asset_code_unique DO NOTHING.
--                  DO NOTHING (not DO UPDATE) so a re-run cannot overwrite the
--                  hand-made category/location bindings on the live rows.
--   * work logs -> deterministic request_id + on conflict on constraint
--                  maintenance_work_logs_org_request_unique DO NOTHING. The
--                  request_id is uuidv5(6f1b2c3d-0000-4000-8000-000000000001,
--                  'mainlink:description:' || source_equipment_id), the same
--                  namespace and scheme 0135 used for its 21 description-derived
--                  entries. The literals below are the values already live.
--
-- Both maintenance entries are description-derived: the repair text existed
-- only in MainLink's equipment.description, which carries no work date.
-- performed_at is not nullable, so it holds the MainLink row-creation
-- timestamp, and every notes value says in plain words that this is not the
-- date the work was done. The MainLink source_equipment_id is preserved
-- verbatim at the end of each notes value.
--
-- performed_by is null: the MainLink user UUIDs live in a different Supabase
-- project's auth.users and would violate the FK. These two rows had no
-- technician recorded in MainLink in any case.

do $$
declare
  v_org             uuid := 'e1b8a6cf-032c-48f0-852a-982dd58b9f9c';
  v_org_name        text;
  v_cat_skyjacks    uuid;
  v_cat_outdoor     uuid;
  v_loc_boiler      uuid;
  v_loc_outdoor     uuid;
  v_n               integer;
begin
  -- ============================================================
  -- Resolve the organization. Abort unless it is uniquely present.
  -- ============================================================
  select count(*) into v_n from public.organizations where id = v_org;
  if v_n <> 1 then
    raise exception
      'Organization % could not be uniquely resolved (found % rows). Refusing to import.',
      v_org, v_n;
  end if;

  select name into v_org_name from public.organizations where id = v_org;
  if v_org_name is distinct from 'First Light Greenhouses inc' then
    raise exception
      'Organization % is named %, expected "First Light Greenhouses inc". Wrong database? Refusing to import.',
      v_org, coalesce(v_org_name, '<null>');
  end if;

  -- ============================================================
  -- Resolve the hand-made setup records by EXACT name. Never create.
  -- ============================================================
  select count(*) into v_n from public.maintenance_categories
   where organization_id = v_org and name = 'SkyJacks';
  if v_n <> 1 then
    raise exception 'Category "SkyJacks" not uniquely resolved for org % (found % rows). Create it in Maintenance Setup first; this migration will not create it.', v_org, v_n;
  end if;
  select id into v_cat_skyjacks from public.maintenance_categories
   where organization_id = v_org and name = 'SkyJacks';

  select count(*) into v_n from public.maintenance_categories
   where organization_id = v_org and name = 'Outdoor Equipment';
  if v_n <> 1 then
    raise exception 'Category "Outdoor Equipment" not uniquely resolved for org % (found % rows). Create it in Maintenance Setup first; this migration will not create it.', v_org, v_n;
  end if;
  select id into v_cat_outdoor from public.maintenance_categories
   where organization_id = v_org and name = 'Outdoor Equipment';

  select count(*) into v_n from public.maintenance_locations
   where organization_id = v_org and name = 'Boiler/Maintenance Room';
  if v_n <> 1 then
    raise exception 'Location "Boiler/Maintenance Room" not uniquely resolved for org % (found % rows). Create it in Maintenance Setup first; this migration will not create it.', v_org, v_n;
  end if;
  select id into v_loc_boiler from public.maintenance_locations
   where organization_id = v_org and name = 'Boiler/Maintenance Room';

  select count(*) into v_n from public.maintenance_locations
   where organization_id = v_org and name = 'Outdoor Equipment';
  if v_n <> 1 then
    raise exception 'Location "Outdoor Equipment" not uniquely resolved for org % (found % rows). Create it in Maintenance Setup first; this migration will not create it.', v_org, v_n;
  end if;
  select id into v_loc_outdoor from public.maintenance_locations
   where organization_id = v_org and name = 'Outdoor Equipment';

  -- ============================================================
  -- 1. Equipment -- SJ-01 and LT-01
  -- ============================================================
  insert into public.maintenance_equipment
    (organization_id, name, asset_code, category_id, location_id, status, make, model, meter_unit, description)
  values
    (v_org, 'Scissor Lift', 'SJ-01', v_cat_skyjacks, v_loc_boiler, 'active',
     'Skyjack', null, 'hours', 'New batteries and battery charger'),
    (v_org, 'Lawn Tractor', 'LT-01', v_cat_outdoor,  v_loc_outdoor, 'active',
     'John Deere', 'X590', 'hours', 'New mower belt changed oil')
  on conflict on constraint maintenance_equipment_org_asset_code_unique do nothing;
  -- LT-01 is status 'maintenance' in MainLink, which is not a legal GrowLink
  -- status (active/out_of_service/retired). Both assets are in service, so
  -- both import as 'active'.

  -- ============================================================
  -- 2. One description-derived maintenance entry per asset
  -- ============================================================
  insert into public.maintenance_work_logs
    (organization_id, equipment_id, equipment_name_snapshot, asset_code_snapshot,
     work_performed, notes, performed_at, performed_by, performed_by_name_snapshot, request_id)
  select v_org, e.id, e.name, e.asset_code, v.work_performed, v.notes,
         v.performed_at, null, 'Unknown (MainLink import)', v.request_id
    from (values
      ('SJ-01',
       'New batteries and battery charger',
       'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-10), not when the work was performed. Source equipment 7627a597-6581-448b-b36a-c57a6946c3bc.',
       timestamptz '2026-07-10 11:11:52+00',
       uuid '7bf5f419-9efa-5252-ad69-c3226be7c442'),
      ('LT-01',
       'New mower belt changed oil',
       'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-12), not when the work was performed. Source equipment bea9ad52-aa92-44ac-9e47-7c5702113523.',
       timestamptz '2026-08-12 13:10:53+00',
       uuid '3a590234-251b-57e1-b650-49c081aa0923')
    ) as v(asset_code, work_performed, notes, performed_at, request_id)
    join public.maintenance_equipment e
      on e.organization_id = v_org
     and e.asset_code_normalized = lower(trim(v.asset_code))
  on conflict on constraint maintenance_work_logs_org_request_unique do nothing;
end $$;
