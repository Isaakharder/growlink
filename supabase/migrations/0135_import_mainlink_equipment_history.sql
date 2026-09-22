-- 0135_import_mainlink_equipment_history.sql
--
-- One-time import of the MainLink maintenance data into GrowLink, for the
-- First Light Greenhouses inc organization -- the org that already holds the
-- four Bogaert scissor lifts 01/02/03/18. NOT Denva, whose 50
-- maintenance_equipment rows are all TST-/WLT-/REPRO- test fixtures.
--
-- MainLink is a separate Supabase project (ppzzrenrtyhnlfzsjkdo); its data is
-- carried across as literals below. Nothing here reads from MainLink at runtime.
--
-- IDEMPOTENT BY CONSTRUCTION -- safe to run repeatedly:
--   * equipment  -> on conflict on constraint
--                   maintenance_equipment_org_asset_code_unique do update.
--                   Existing rows keep their GrowLink id, qr_token, created_at.
--   * work logs  -> deterministic request_id + on conflict on constraint
--                   maintenance_work_logs_org_request_unique do nothing. Real
--                   MainLink logs reuse the MainLink work-log UUID as their
--                   request_id; description-derived entries use a uuidv5 of the
--                   MainLink equipment UUID. Neither can be inserted twice.
--
-- NOT IMPORTED, because the data does not exist: MainLink's work-log table is
-- (id, organization_id, work_order_id, equipment_id, user_id, notes,
-- completed_at, created_at) -- it has no cost, parts, labour-hours or per-log
-- status columns. MainLink's three maintenance_work_orders rows all belong to
-- its Smoke Test Org, not to Mainlink.
--
-- performed_by is null on every imported row: the MainLink user UUIDs belong to
-- a different Supabase project's auth.users and would violate the FK. The
-- technician name is preserved in performed_by_name_snapshot, which is the
-- field the maintenance page displays.

do $$
declare
  v_org uuid := 'e1b8a6cf-032c-48f0-852a-982dd58b9f9c';
  v_cat uuid;
  v_loc uuid;
begin
  select id into v_cat from public.maintenance_categories
   where organization_id = v_org and name_normalized = 'scissor lifts';
  select id into v_loc from public.maintenance_locations
   where organization_id = v_org and name_normalized = 'greenhouse';

  if v_cat is null then
    raise exception 'Category "Scissor lifts" not found for org %', v_org;
  end if;
  if v_loc is null then
    raise exception 'Location "Greenhouse" not found for org %', v_org;
  end if;

  -- ============================================================
  -- 1. Equipment -- 22 Bogaert greenhouse scissor lifts
  -- ============================================================
  insert into public.maintenance_equipment
    (organization_id, name, asset_code, category_id, location_id, status, model, meter_unit, description)
  values
    (v_org, 'Scissor Lift', '01', v_cat, v_loc, 'active', 'Bogaert', 'hours', null),
    (v_org, 'Scissor Lift', '02', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New batteries, new plastic on foot pedal'),
    (v_org, 'Scissor Lift', '03', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'Ripped charger cord, and replaced plastic cover on foot pedal'),
    (v_org, 'Scissor Lift', '05', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New chain and new foot pedal'),
    (v_org, 'Scissor Lift', '06', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New foot pedal and plastic that cover covers foot pedal'),
    (v_org, 'Scissor Lift', '07', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'July 23 New batteries'),
    (v_org, 'Scissor Lift', '08', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New batteries, new plastic on foot pedal'),
    (v_org, 'Scissor Lift', '11', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New foot pedal new plastic on foot pedal new batteries'),
    (v_org, 'Scissor Lift', '13', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New battery’s and fuse for foot pedal'),
    (v_org, 'Scissor Lift', '14', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New batteries adjusting on landing feet and new plastic on the foot pedal'),
    (v_org, 'Scissor Lift', '15', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'Titan chain and replace plastic cover on foot pedal'),
    (v_org, 'Scissor Lift', '17', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New foot pedal new foot pedal plastic cover new solenoid for hydraulics'),
    (v_org, 'Scissor Lift', '18', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'Replenished hydraulic fluid and replaced plastic cover on footpedal'),
    (v_org, 'Scissor Lift', '20', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New Killswitch new plastic on foot pedal'),
    (v_org, 'Scissor Lift', '22', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New solenoid for hydraulic lift and new brushes on the drive motor'),
    (v_org, 'Scissor Lift', '23', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New batteries and new plastic cover on foot pedal'),
    (v_org, 'Scissor Lift', '25', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New hydraulic hose'),
    (v_org, 'Scissor Lift', '26', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'Replace speed control'),
    (v_org, 'Scissor Lift', '27', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'Replace footpedal replace plastic on foot pedal'),
    (v_org, 'Scissor Lift', '30', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New battery’s new foot pedal new plastic over foot pedal'),
    (v_org, 'Scissor Lift', '31', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New chain on drive motor new plastic on foot pedal'),
    (v_org, 'Scissor Lift', '66', v_cat, v_loc, 'active', 'Bogaert', 'hours', 'New batteries')
  on conflict on constraint maintenance_equipment_org_asset_code_unique do update
    set name        = excluded.name,
        category_id = excluded.category_id,
        location_id = excluded.location_id,
        model       = excluded.model,
        meter_unit  = excluded.meter_unit,
        -- never blank an existing GrowLink description with a null from MainLink
        description = coalesce(excluded.description, public.maintenance_equipment.description),
        updated_at  = now();
  -- status is deliberately NOT updated. MainLink's 'maintenance' value is not a
  -- legal GrowLink status (active/out_of_service/retired), and every one of
  -- these lifts is in service -- the notes are completed past repairs, not open
  -- faults. New rows insert as 'active'; the four existing rows keep theirs.

  -- ============================================================
  -- 2. The 8 real MainLink work logs
  -- ============================================================
  insert into public.maintenance_work_logs
    (organization_id, equipment_id, equipment_name_snapshot, asset_code_snapshot,
     work_performed, notes, performed_at, performed_by, performed_by_name_snapshot, request_id)
  select v_org, e.id, e.name, e.asset_code, v.work_performed, v.notes,
         v.performed_at, null, v.tech, v.request_id
    from (values
      ('01', 'Oil topped up', 'Imported from MainLink work log 5abf8533-7e29-414d-a86b-6d42fde3b8a8 (completed_at 2026-07-09 19:43:57).', timestamptz '2026-07-09 19:43:57.381+00', 'Isaak', uuid '5abf8533-7e29-414d-a86b-6d42fde3b8a8'),
      ('07', 'Check charging system working. Replace plastic cover on foot pedal lifting wheels were not engaging working now.', 'Imported from MainLink work log f6abf18c-1dfe-4abb-ab29-cd8ebce87cc7 (completed_at 2026-07-15 15:47:27).', timestamptz '2026-07-15 15:47:27.379+00', 'Dave Quiring', uuid 'f6abf18c-1dfe-4abb-ab29-cd8ebce87cc7'),
      ('18', 'New hydraulic solenoid', 'Imported from MainLink work log 0843b94f-8b94-4b5e-9935-135250fd194b (completed_at 2026-08-07 15:43:21).', timestamptz '2026-08-07 15:43:21.601+00', 'Dave Quiring', uuid '0843b94f-8b94-4b5e-9935-135250fd194b'),
      ('27', 'New batteries', 'Imported from MainLink work log bc20072d-6253-4394-b1db-9bc025b6ffca (completed_at 2026-08-07 17:24:39).', timestamptz '2026-08-07 17:24:39.116+00', 'Dave Quiring', uuid 'bc20072d-6253-4394-b1db-9bc025b6ffca'),
      ('18', 'New batteries', 'Imported from MainLink work log 466e5a63-d246-4a46-a967-2ed01672cfe1 (completed_at 2026-08-19 12:25:20).', timestamptz '2026-08-19 12:25:20.593+00', 'Dave Quiring', uuid '466e5a63-d246-4a46-a967-2ed01672cfe1'),
      ('01', 'New foot pedal new plastic cover on foot pedal', 'Imported from MainLink work log fd878442-878a-442b-bd27-b1dd9c6fd8c6 (completed_at 2026-08-24 19:24:26).', timestamptz '2026-08-24 19:24:26.437+00', 'Dave Quiring', uuid 'fd878442-878a-442b-bd27-b1dd9c6fd8c6'),
      ('06', 'New speed control', 'Imported from MainLink work log c6e1bbdc-992b-43c5-9c92-18661dfd50da (completed_at 2026-09-02 13:14:09).', timestamptz '2026-09-02 13:14:09.107+00', 'Dave Quiring', uuid 'c6e1bbdc-992b-43c5-9c92-18661dfd50da'),
      ('01', 'New batteries', 'Imported from MainLink work log c66bd515-a259-420c-a80b-04ec78682855 (completed_at 2026-09-08 17:41:18).', timestamptz '2026-09-08 17:41:18.783+00', 'Dave Quiring', uuid 'c66bd515-a259-420c-a80b-04ec78682855')
    ) as v(asset_code, work_performed, notes, performed_at, tech, request_id)
    join public.maintenance_equipment e
      on e.organization_id = v_org and e.asset_code_normalized = lower(trim(v.asset_code))
  on conflict on constraint maintenance_work_logs_org_request_unique do nothing;

  -- ============================================================
  -- 3. 21 repairs that existed only in MainLink's equipment.description.
  --    work_performed is the source text verbatim; the date the work actually
  --    happened was never recorded anywhere in MainLink.
  -- ============================================================
  insert into public.maintenance_work_logs
    (organization_id, equipment_id, equipment_name_snapshot, asset_code_snapshot,
     work_performed, notes, performed_at, performed_by, performed_by_name_snapshot, request_id)
  select v_org, e.id, e.name, e.asset_code, v.work_performed, v.notes,
         v.performed_at, null, 'Unknown (MainLink import)', v.request_id
    from (values
      ('02', 'New batteries, new plastic on foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-11), not when the work was performed. Source equipment 34eeaf74-d1c1-4709-a688-b266c68518ce.', timestamptz '2026-08-11 15:39:27+00', uuid '2518a0bf-b2e0-51e8-8333-4009ddd19cc5'),
      ('03', 'Ripped charger cord, and replaced plastic cover on foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-13), not when the work was performed. Source equipment c7c9d62c-632d-4422-8532-109368c0ed1d.', timestamptz '2026-07-13 15:37:51+00', uuid 'a98d3969-f7c4-5aa2-a988-b8667f7980e7'),
      ('05', 'New chain and new foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-13), not when the work was performed. Source equipment 05b57692-ff13-4220-aa14-53e5a8f2931a.', timestamptz '2026-07-13 14:11:27+00', uuid '932197ce-7eb9-5977-965f-fb5d9226007b'),
      ('06', 'New foot pedal and plastic that cover covers foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-28), not when the work was performed. Source equipment 45b63e97-e287-491d-b539-bbac250966c5.', timestamptz '2026-07-28 19:46:32+00', uuid '4018cb36-d5fe-53bf-9e34-2d8f442b2909'),
      ('07', 'July 23 New batteries', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-13), not when the work was performed. Source equipment d6591e39-888a-47ce-86db-f0b8d9d30c56.', timestamptz '2026-07-13 15:35:59+00', uuid 'b5194736-a999-5a49-9fd2-4ccf22b1f094'),
      ('08', 'New batteries, new plastic on foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-07), not when the work was performed. Source equipment 2cfad5a9-bd05-48f7-92e9-88edf0a60a80.', timestamptz '2026-08-07 19:31:48+00', uuid 'c6776a9b-c902-5878-9137-3242fea4c941'),
      ('11', 'New foot pedal new plastic on foot pedal new batteries', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-24), not when the work was performed. Source equipment a66f35c1-2efb-4e51-8427-cbdefd619ea5.', timestamptz '2026-08-24 15:37:11+00', uuid '75b6e604-6709-5b54-8f87-ea88c5340059'),
      ('13', 'New battery’s and fuse for foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-10), not when the work was performed. Source equipment ecf20f99-82de-4a09-8170-44513f9804a9.', timestamptz '2026-07-10 11:10:45+00', uuid '5f97a94c-005f-50bf-8889-6a284d8f6486'),
      ('14', 'New batteries adjusting on landing feet and new plastic on the foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-27), not when the work was performed. Source equipment 52fdfe83-f881-4e2a-a9c6-9dc3e995a1e1.', timestamptz '2026-07-27 20:06:11+00', uuid 'da7c3903-287c-5eb6-be8b-48438e56ff3a'),
      ('15', 'Titan chain and replace plastic cover on foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-13), not when the work was performed. Source equipment 8437f98f-3ce6-4205-90c3-67db519af031.', timestamptz '2026-07-13 15:24:42+00', uuid '3c218790-a101-50ed-a8e5-344781ab0282'),
      ('17', 'New foot pedal new foot pedal plastic cover new solenoid for hydraulics', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-20), not when the work was performed. Source equipment 0d4202bb-b6bf-496d-86cf-9f42b4323d86.', timestamptz '2026-08-20 15:39:49+00', uuid '7aa7931e-8c64-54dd-abb5-8582bad37a7c'),
      ('18', 'Replenished hydraulic fluid and replaced plastic cover on footpedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-13), not when the work was performed. Source equipment 4241442a-ab1a-4c4e-862c-b3e92d2b0d64.', timestamptz '2026-07-13 15:38:33+00', uuid 'ff175e5c-2dfa-5259-bfd2-06cca29a7b6e'),
      ('20', 'New Killswitch new plastic on foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-28), not when the work was performed. Source equipment 8f27245b-6075-4355-8104-0da242ad3d6d.', timestamptz '2026-07-28 13:42:31+00', uuid '16321e72-469b-51dc-a03b-07008253ec3a'),
      ('22', 'New solenoid for hydraulic lift and new brushes on the drive motor', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-19), not when the work was performed. Source equipment 262e7881-dbf8-4c51-a8ac-644db8ea1a19.', timestamptz '2026-08-19 14:17:52+00', uuid '96195af9-1fbd-5973-98dc-f6346200af74'),
      ('23', 'New batteries and new plastic cover on foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-28), not when the work was performed. Source equipment 56b223ee-3d0c-415c-8a6d-fae30de56920.', timestamptz '2026-07-28 12:37:10+00', uuid '37a1cade-69f4-50f1-877b-97873e33c141'),
      ('25', 'New hydraulic hose', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-19), not when the work was performed. Source equipment c1712e4e-29c9-4de7-a911-9d7c9aefab3b.', timestamptz '2026-08-19 19:25:32+00', uuid '75e3530b-1f3c-5819-860b-5c47f55fcc12'),
      ('26', 'Replace speed control', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-16), not when the work was performed. Source equipment 7f21c9a6-d4da-4dd2-a7d1-06d95bdbfea1.', timestamptz '2026-07-16 11:40:29+00', uuid '8060e51b-9c88-5bb4-a270-9f5f00937cd7'),
      ('27', 'Replace footpedal replace plastic on foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-07-20), not when the work was performed. Source equipment b734e740-d636-4c86-93a0-58b295a66f31.', timestamptz '2026-07-20 14:41:44+00', uuid 'f5776b1d-a0d5-55f7-8a2d-a09ce9d5fdeb'),
      ('30', 'New battery’s new foot pedal new plastic over foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-06), not when the work was performed. Source equipment f37be73f-aca3-4a3d-8140-569fbe50aabd.', timestamptz '2026-08-06 12:44:38+00', uuid '332146ba-a140-56d4-99d6-bb487f63eca1'),
      ('31', 'New chain on drive motor new plastic on foot pedal', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-13), not when the work was performed. Source equipment 018b1700-0cf0-4835-b0e9-3fd860a990b2.', timestamptz '2026-08-13 15:59:02+00', uuid '28f4dce0-7d58-5c06-8611-d75745b28e1e'),
      ('66', 'New batteries', 'Date not recorded in MainLink. This repair existed only in the MainLink equipment Description field, which carries no work date. The timestamp on this entry is when the note was entered in MainLink (2026-08-21), not when the work was performed. Source equipment ea2b5257-aa90-4c7c-8e6e-110a90f22912.', timestamptz '2026-08-21 19:58:03+00', uuid 'a1b527b8-1051-57d7-9080-40930f86e528')
    ) as v(asset_code, work_performed, notes, performed_at, request_id)
    join public.maintenance_equipment e
      on e.organization_id = v_org and e.asset_code_normalized = lower(trim(v.asset_code))
  on conflict on constraint maintenance_work_logs_org_request_unique do nothing;
end $$;
