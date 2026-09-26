-- 0139_convert_legacy_levente.sql
--
-- One-time conversion for First Light Greenhouses inc: the legacy "Levente"
-- variety, used before the crop was tracked per greenhouse phase, is
-- converted into "Levente Phase 2" and "Levente Phase 3", then archived.
-- Approved preview: docs in the PR; every figure below is literal so the
-- migration is exactly what was reviewed.
--
-- Weeks 17-26 (10 entries, 174,958 kg): each week is split with one
-- constant ratio - the observed Phase 2 : Phase 3 production over weeks
-- 27-39, 79059057 g : 106635190 g (Phase 2 share 79059057/185694247, 42.5749%).
-- Split in whole grams: Phase 2 = round(kg x share), Phase 3 = the
-- remainder; each size bucket split the same way (largest remainder), so
-- every week's total and every size bucket add back to the original. No
-- Phase 2/3 entry exists in these weeks, so each phase gets a new entry with
-- the week's legacy AFW, packed date and created_at.
--
-- Week 27 (13,691 kg): NOT converted. It is the same Phase 3 production that
-- was later re-entered as Levente Phase 3 week 27 (13,553 kg, 2026-08-04) -
-- confirmed by the grower after comparing size profiles. It is backed up and
-- removed, so those kilograms are no longer counted twice. The existing
-- Phase 2 and Phase 3 week 27 entries are not touched.
--
-- Also: the legacy daily breakdowns are split the same way onto the new
-- entries; the 91 daily yield samples tagged "Levente" are retagged by the
-- phase of the physical row they record (not split); the legacy variety is
-- set inactive, keeping its id and name.
--
-- SAFETY
--   * Only this organization and these exact variety ids.
--   * Every legacy row, breakdown and sample is checked against the
--     reviewed values first; any difference aborts before anything changes.
--   * The whole conversion is one DO block: any failed check rolls back all.
--   * variety_conversions holds a marker; a second run is a no-op.
--   * variety_conversion_rows keeps every original row image and every
--     generated row id - supabase/maintenance/rollback_0139_levente_conversion.sql
--     restores the exact pre-conversion state from it.
--   * No import run, retained source file or audit history references the
--     legacy variety; none is touched.

create table if not exists public.variety_conversions (
  conversion_key     text primary key,
  organization_id    uuid not null references public.organizations(id),
  legacy_variety_id  uuid not null references public.varieties(id),
  applied_at         timestamptz not null default now(),
  summary            jsonb not null
);

create table if not exists public.variety_conversion_rows (
  id              uuid primary key default gen_random_uuid(),
  conversion_key  text not null references public.variety_conversions(conversion_key),
  role            text not null check (role in ('original', 'generated')),
  table_name      text not null,
  row_id          uuid not null,
  row_data        jsonb,
  constraint variety_conversion_rows_unique unique (conversion_key, role, table_name, row_id)
);

alter table public.variety_conversions enable row level security;
alter table public.variety_conversion_rows enable row level security;
grant select, insert, update, delete on table public.variety_conversions to service_role;
grant select, insert, update, delete on table public.variety_conversion_rows to service_role;

do $$
declare
  k           constant text := 'first-light-2026-legacy-levente';
  v_org       constant uuid := 'e1b8a6cf-032c-48f0-852a-982dd58b9f9c';
  v_legacy    constant uuid := 'd8f19f12-4b1b-4a14-b5b7-9aa3894478a1';
  v_p2        constant uuid := 'd787404a-7334-4719-ae8c-1c45c4b7a10e';
  v_p3        constant uuid := '8105bf4c-eb16-4415-812a-3b50f865fe8e';
  v_phase2    constant uuid := '4044e9f5-f51c-49c6-ba6d-781f1821b857';
  v_phase3    constant uuid := 'e3a4ad8a-775f-4472-8658-c74e60264314';
  v_p2_w27    constant uuid := '104f2c20-1486-4b24-9be0-22da93a27e5d';
  v_p3_w27    constant uuid := 'f4571a91-b081-468c-a991-a4d037da2829';
  v_n         integer;
  v_farm_before numeric;
  v_farm_after  numeric;
  v_expected  record;
begin
  if exists (select 1 from public.variety_conversions where conversion_key = k) then
    raise notice '0139: conversion % already applied; nothing to do', k;
    return;
  end if;

  -- ---------------------------------------------------------------- checks
  if not exists (select 1 from public.organizations where id = v_org and name = 'First Light Greenhouses inc') then
    raise exception '0139: organization % not found', v_org;
  end if;
  for v_expected in select * from (values (v_legacy, 'Levente'), (v_p2, 'Levente Phase 2'), (v_p3, 'Levente Phase 3')) as t(id, name) loop
    if not exists (select 1 from public.varieties where id = v_expected.id and organization_id = v_org and trim(name) = v_expected.name) then
      raise exception '0139: variety "%" (%) not found in organization %', v_expected.name, v_expected.id, v_org;
    end if;
  end loop;

  create temp table _expected_entries (id uuid primary key, week int, total_kg numeric, size_kg jsonb, packed_date date, action text) on commit drop;
  insert into _expected_entries values
    ('22e70bba-03e5-41bf-b8d5-2a4e903d78d0'::uuid, 17, 32126.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 433.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 172.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 164.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 459.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 2605.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 28293.000}'::jsonb, null::date, 'convert'),
    ('c173d798-ffcb-4af6-93fa-e753b723419e'::uuid, 18, 12779.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 23.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 24.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 45.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 139.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 1510.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 11038.000}'::jsonb, null::date, 'convert'),
    ('fc62c89d-e6c3-4394-88a1-6e07a789b9bb'::uuid, 19, 9701.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 23.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 32.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 82.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 269.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 2127.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 7168.000}'::jsonb, null::date, 'convert'),
    ('a257f75b-e4f9-48e1-86ed-113f2966168e'::uuid, 20, 16184.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 27.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 42.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 115.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 369.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 3015.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 12616.000}'::jsonb, null::date, 'convert'),
    ('06ef048c-9441-4e4d-8666-3ef696d9ad8a'::uuid, 21, 26569.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 66.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 103.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 277.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 834.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 7367.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 17922.000}'::jsonb, null::date, 'convert'),
    ('241c8ecf-92b4-456f-a1a9-389b15e58fda'::uuid, 22, 12324.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 41.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 80.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 151.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 466.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 4105.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 7481.000}'::jsonb, null::date, 'convert'),
    ('f666e7db-fbfa-4373-a5d6-6a0abfc74eaa'::uuid, 23, 16931.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 43.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 87.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 197.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 615.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 6369.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 9620.000}'::jsonb, null::date, 'convert'),
    ('68995b2d-181e-490f-90b8-93a1dde3c302'::uuid, 24, 17261.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 49.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 98.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 330.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 555.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 10433.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 5796.000}'::jsonb, null::date, 'convert'),
    ('5825593e-66a4-4d44-908e-d68a5e7b3db3'::uuid, 25, 20115.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 66.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 159.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 567.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 817.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 10777.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 7729.000}'::jsonb, '2026-06-18'::date, 'convert'),
    ('5f031b29-fe3f-44b4-8e6c-76680c2dd1fa'::uuid, 26, 10968.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 44.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 97.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 294.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 648.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 6367.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 3518.000}'::jsonb, '2026-06-23'::date, 'convert'),
    ('07891d3f-a56d-458c-85c6-8d345c5c1e08'::uuid, 27, 13691.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 57.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 137.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 542.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 1017.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 7904.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 4034.000}'::jsonb, '2026-06-29'::date, 'duplicate');

  create temp table _split (legacy_id uuid, week int, variety_id uuid, total_kg numeric, size_kg jsonb, new_id uuid) on commit drop;
  insert into _split (legacy_id, week, variety_id, total_kg, size_kg) values
    ('22e70bba-03e5-41bf-b8d5-2a4e903d78d0'::uuid, 17, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 13677.598, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 184.349, "37e1390f-7352-48db-994e-8495fa97d6e7": 73.229, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 69.823, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 195.418, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 1109.075, "25b827d4-cbab-468d-b5fc-e69253b878ae": 12045.704}'::jsonb),
    ('22e70bba-03e5-41bf-b8d5-2a4e903d78d0'::uuid, 17, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 18448.402, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 248.651, "37e1390f-7352-48db-994e-8495fa97d6e7": 98.771, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 94.177, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 263.582, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 1495.925, "25b827d4-cbab-468d-b5fc-e69253b878ae": 16247.296}'::jsonb),
    ('c173d798-ffcb-4af6-93fa-e753b723419e'::uuid, 18, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 5440.641, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 9.792, "37e1390f-7352-48db-994e-8495fa97d6e7": 10.218, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 19.159, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 59.179, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 642.880, "25b827d4-cbab-468d-b5fc-e69253b878ae": 4699.413}'::jsonb),
    ('c173d798-ffcb-4af6-93fa-e753b723419e'::uuid, 18, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 7338.359, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 13.208, "37e1390f-7352-48db-994e-8495fa97d6e7": 13.782, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 25.841, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 79.821, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 867.120, "25b827d4-cbab-468d-b5fc-e69253b878ae": 6338.587}'::jsonb),
    ('fc62c89d-e6c3-4394-88a1-6e07a789b9bb'::uuid, 19, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 4130.187, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 9.792, "37e1390f-7352-48db-994e-8495fa97d6e7": 13.624, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 34.912, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 114.526, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 905.567, "25b827d4-cbab-468d-b5fc-e69253b878ae": 3051.766}'::jsonb),
    ('fc62c89d-e6c3-4394-88a1-6e07a789b9bb'::uuid, 19, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 5570.813, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 13.208, "37e1390f-7352-48db-994e-8495fa97d6e7": 18.376, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 47.088, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 154.474, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 1221.433, "25b827d4-cbab-468d-b5fc-e69253b878ae": 4116.234}'::jsonb),
    ('a257f75b-e4f9-48e1-86ed-113f2966168e'::uuid, 20, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 6890.315, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 11.495, "37e1390f-7352-48db-994e-8495fa97d6e7": 17.882, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 48.961, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 157.101, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 1283.632, "25b827d4-cbab-468d-b5fc-e69253b878ae": 5371.244}'::jsonb),
    ('a257f75b-e4f9-48e1-86ed-113f2966168e'::uuid, 20, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 9293.685, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 15.505, "37e1390f-7352-48db-994e-8495fa97d6e7": 24.118, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 66.039, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 211.899, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 1731.368, "25b827d4-cbab-468d-b5fc-e69253b878ae": 7244.756}'::jsonb),
    ('06ef048c-9441-4e4d-8666-3ef696d9ad8a'::uuid, 21, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 11311.713, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 28.100, "37e1390f-7352-48db-994e-8495fa97d6e7": 43.852, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 117.932, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 355.074, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 3136.490, "25b827d4-cbab-468d-b5fc-e69253b878ae": 7630.265}'::jsonb),
    ('06ef048c-9441-4e4d-8666-3ef696d9ad8a'::uuid, 21, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 15257.287, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 37.900, "37e1390f-7352-48db-994e-8495fa97d6e7": 59.148, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 159.068, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 478.926, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 4230.510, "25b827d4-cbab-468d-b5fc-e69253b878ae": 10291.735}'::jsonb),
    ('241c8ecf-92b4-456f-a1a9-389b15e58fda'::uuid, 22, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 5246.925, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 17.455, "37e1390f-7352-48db-994e-8495fa97d6e7": 34.060, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 64.288, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 198.399, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 1747.698, "25b827d4-cbab-468d-b5fc-e69253b878ae": 3185.025}'::jsonb),
    ('241c8ecf-92b4-456f-a1a9-389b15e58fda'::uuid, 22, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 7077.075, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 23.545, "37e1390f-7352-48db-994e-8495fa97d6e7": 45.940, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 86.712, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 267.601, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 2357.302, "25b827d4-cbab-468d-b5fc-e69253b878ae": 4295.975}'::jsonb),
    ('f666e7db-fbfa-4373-a5d6-6a0abfc74eaa'::uuid, 23, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 7208.349, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 18.307, "37e1390f-7352-48db-994e-8495fa97d6e7": 37.040, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 83.873, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 261.835, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 2711.593, "25b827d4-cbab-468d-b5fc-e69253b878ae": 4095.701}'::jsonb),
    ('f666e7db-fbfa-4373-a5d6-6a0abfc74eaa'::uuid, 23, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 9722.651, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 24.693, "37e1390f-7352-48db-994e-8495fa97d6e7": 49.960, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 113.127, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 353.165, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 3657.407, "25b827d4-cbab-468d-b5fc-e69253b878ae": 5524.299}'::jsonb),
    ('68995b2d-181e-490f-90b8-93a1dde3c302'::uuid, 24, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 7348.846, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 20.862, "37e1390f-7352-48db-994e-8495fa97d6e7": 41.723, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 140.497, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 236.290, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 4441.835, "25b827d4-cbab-468d-b5fc-e69253b878ae": 2467.639}'::jsonb),
    ('68995b2d-181e-490f-90b8-93a1dde3c302'::uuid, 24, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 9912.154, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 28.138, "37e1390f-7352-48db-994e-8495fa97d6e7": 56.277, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 189.503, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 318.710, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 5991.165, "25b827d4-cbab-468d-b5fc-e69253b878ae": 3328.361}'::jsonb),
    ('5825593e-66a4-4d44-908e-d68a5e7b3db3'::uuid, 25, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 8563.932, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 28.099, "37e1390f-7352-48db-994e-8495fa97d6e7": 67.694, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 241.399, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 347.837, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 4588.292, "25b827d4-cbab-468d-b5fc-e69253b878ae": 3290.611}'::jsonb),
    ('5825593e-66a4-4d44-908e-d68a5e7b3db3'::uuid, 25, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 11551.068, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 37.901, "37e1390f-7352-48db-994e-8495fa97d6e7": 91.306, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 325.601, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 469.163, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 6188.708, "25b827d4-cbab-468d-b5fc-e69253b878ae": 4438.389}'::jsonb),
    ('5f031b29-fe3f-44b4-8e6c-76680c2dd1fa'::uuid, 26, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 4669.610, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 18.733, "37e1390f-7352-48db-994e-8495fa97d6e7": 41.298, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 125.170, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 275.885, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 2710.741, "25b827d4-cbab-468d-b5fc-e69253b878ae": 1497.783}'::jsonb),
    ('5f031b29-fe3f-44b4-8e6c-76680c2dd1fa'::uuid, 26, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 6298.390, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 25.267, "37e1390f-7352-48db-994e-8495fa97d6e7": 55.702, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 168.830, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 372.115, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 3656.259, "25b827d4-cbab-468d-b5fc-e69253b878ae": 2020.217}'::jsonb);
  -- Deterministic ids for the new entries (same legacy entry + phase -> same id on any run).
  update _split set new_id = md5(legacy_id::text || ':' || variety_id::text)::uuid;

  create temp table _expected_breakdowns (id uuid primary key, yield_entry_id uuid, packed_date date, total_kg numeric, size_kg jsonb) on commit drop;
  insert into _expected_breakdowns values
    ('0329985f-5d32-4830-b42d-8590cea60a4a'::uuid, '5825593e-66a4-4d44-908e-d68a5e7b3db3'::uuid, '2026-06-18'::date, 20115.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 66.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 159.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 567.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 817.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 10777.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 7729.000}'::jsonb),
    ('350e2212-eb52-4e8d-bf1e-a0c9bb29235f'::uuid, '5f031b29-fe3f-44b4-8e6c-76680c2dd1fa'::uuid, '2026-06-23'::date, 9715.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 37.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 83.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 264.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 542.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 5769.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 3020.000}'::jsonb),
    ('d59b9d1b-2cb2-42f5-aa9b-b095a8c25454'::uuid, '5f031b29-fe3f-44b4-8e6c-76680c2dd1fa'::uuid, '2026-06-24'::date, 1253.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 7.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 14.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 30.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 106.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 598.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 498.000}'::jsonb),
    ('f653fe09-e3a5-4e7c-98e4-395b37b476be'::uuid, '07891d3f-a56d-458c-85c6-8d345c5c1e08'::uuid, '2026-06-29'::date, 13691.000, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 57.000, "37e1390f-7352-48db-994e-8495fa97d6e7": 137.000, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 542.000, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 1017.000, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 7904.000, "25b827d4-cbab-468d-b5fc-e69253b878ae": 4034.000}'::jsonb);

  create temp table _breakdown_split (breakdown_id uuid, variety_id uuid, total_kg numeric, size_kg jsonb) on commit drop;
  insert into _breakdown_split values
    ('0329985f-5d32-4830-b42d-8590cea60a4a'::uuid, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 8563.932, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 28.099, "37e1390f-7352-48db-994e-8495fa97d6e7": 67.694, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 241.399, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 347.837, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 4588.292, "25b827d4-cbab-468d-b5fc-e69253b878ae": 3290.611}'::jsonb),
    ('0329985f-5d32-4830-b42d-8590cea60a4a'::uuid, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 11551.068, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 37.901, "37e1390f-7352-48db-994e-8495fa97d6e7": 91.306, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 325.601, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 469.163, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 6188.708, "25b827d4-cbab-468d-b5fc-e69253b878ae": 4438.389}'::jsonb),
    ('350e2212-eb52-4e8d-bf1e-a0c9bb29235f'::uuid, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 4136.147, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 15.753, "37e1390f-7352-48db-994e-8495fa97d6e7": 35.337, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 112.398, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 230.756, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 2456.143, "25b827d4-cbab-468d-b5fc-e69253b878ae": 1285.760}'::jsonb),
    ('350e2212-eb52-4e8d-bf1e-a0c9bb29235f'::uuid, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 5578.853, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 21.247, "37e1390f-7352-48db-994e-8495fa97d6e7": 47.663, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 151.602, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 311.244, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 3312.857, "25b827d4-cbab-468d-b5fc-e69253b878ae": 1734.240}'::jsonb),
    ('d59b9d1b-2cb2-42f5-aa9b-b095a8c25454'::uuid, 'd787404a-7334-4719-ae8c-1c45c4b7a10e'::uuid, 533.463, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 2.980, "37e1390f-7352-48db-994e-8495fa97d6e7": 5.961, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 12.772, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 45.129, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 254.598, "25b827d4-cbab-468d-b5fc-e69253b878ae": 212.023}'::jsonb),
    ('d59b9d1b-2cb2-42f5-aa9b-b095a8c25454'::uuid, '8105bf4c-eb16-4415-812a-3b50f865fe8e'::uuid, 719.537, '{"0d38734a-bb1a-4cb2-a3b2-2d148dd2286a": 4.020, "37e1390f-7352-48db-994e-8495fa97d6e7": 8.039, "ba064041-e6cb-44e4-a455-3b54b5436a7e": 17.228, "1ae03480-2b7d-4ac6-acdc-167f60a663ce": 60.871, "622ae06d-d232-4a3c-af88-bdcc53ad6009": 343.402, "25b827d4-cbab-468d-b5fc-e69253b878ae": 285.977}'::jsonb);

  -- The legacy variety's entries are exactly the reviewed ones.
  select count(*) into v_n from public.yield_entries where organization_id = v_org and variety_id = v_legacy;
  if v_n <> (select count(*) from _expected_entries) then
    raise exception '0139: expected % legacy Levente entries, found %', (select count(*) from _expected_entries), v_n;
  end if;
  select count(*) into v_n
    from _expected_entries x
    join public.yield_entries e on e.id = x.id
   where e.organization_id = v_org and e.variety_id = v_legacy and e.year = 2026 and e.week = x.week
     and e.total_kg = x.total_kg
     and e.packed_date is not distinct from x.packed_date
     and not exists (
       select 1 from jsonb_each_text(x.size_kg) s
        where coalesce((e.size_kg ->> s.key)::numeric, 0) <> s.value::numeric)
     and not exists (
       select 1 from jsonb_each_text(e.size_kg) s
        where not (x.size_kg ? s.key) and s.value::numeric <> 0);
  if v_n <> (select count(*) from _expected_entries) then
    raise exception '0139: % of the legacy Levente entries differ from the reviewed values', (select count(*) from _expected_entries) - v_n;
  end if;
  if (select sum(total_kg) from public.yield_entries where organization_id = v_org and variety_id = v_legacy) <> 188649 then
    raise exception '0139: legacy Levente total is not 188,649 kg';
  end if;

  -- No Phase 2 / Phase 3 entry already exists in the converted weeks.
  if exists (
    select 1 from public.yield_entries
     where organization_id = v_org and variety_id in (v_p2, v_p3) and year = 2026
       and week in (select week from _expected_entries where action = 'convert')
  ) then
    raise exception '0139: a Levente Phase 2/3 entry already exists in weeks 17-26; resolve it before converting';
  end if;

  -- The week 27 entries the duplicate is resolved against are the reviewed ones.
  if not exists (select 1 from public.yield_entries where id = v_p3_w27 and organization_id = v_org and variety_id = v_p3 and year = 2026 and week = 27 and total_kg = 13553)
     or not exists (select 1 from public.yield_entries where id = v_p2_w27 and organization_id = v_org and variety_id = v_p2 and year = 2026 and week = 27 and total_kg = 7083) then
    raise exception '0139: the Levente Phase 2/3 week 27 entries differ from the reviewed ones';
  end if;

  -- Breakdowns: exactly the reviewed ones.
  select count(*) into v_n from public.yield_entry_daily_breakdown b
   where b.yield_entry_id in (select id from _expected_entries);
  if v_n <> (select count(*) from _expected_breakdowns) then
    raise exception '0139: expected % legacy daily breakdowns, found %', (select count(*) from _expected_breakdowns), v_n;
  end if;
  select count(*) into v_n
    from _expected_breakdowns x
    join public.yield_entry_daily_breakdown b on b.id = x.id
   where b.yield_entry_id = x.yield_entry_id and b.total_kg = x.total_kg
     and b.packed_date is not distinct from x.packed_date
     and not exists (select 1 from jsonb_each_text(x.size_kg) s where coalesce((b.size_kg ->> s.key)::numeric, 0) <> s.value::numeric);
  if v_n <> (select count(*) from _expected_breakdowns) then
    raise exception '0139: % legacy daily breakdowns differ from the reviewed values', (select count(*) from _expected_breakdowns) - v_n;
  end if;

  -- Samples: every legacy-tagged sample records a Phase 2 or Phase 3 row.
  select count(*) into v_n from public.daily_yield_samples where variety_id = v_legacy;
  if v_n <> 91 then
    raise exception '0139: expected 91 daily yield samples tagged Levente, found %', v_n;
  end if;
  if exists (select 1 from public.daily_yield_samples where variety_id = v_legacy and phase_id is distinct from v_phase2 and phase_id is distinct from v_phase3) then
    raise exception '0139: a Levente-tagged daily yield sample has no Phase 2/3 row; cannot retag it';
  end if;

  select coalesce(sum(total_kg), 0) into v_farm_before from public.yield_entries where organization_id = v_org and year = 2026;

  -- ---------------------------------------------------------------- marker + backup
  insert into public.variety_conversions (conversion_key, organization_id, legacy_variety_id, summary)
  values (k, v_org, v_legacy, jsonb_build_object(
    'method', 'constant observed Phase 2 : Phase 3 ratio, weeks 27-39',
    'phase2_share_numerator_g', 79059057, 'phase2_share_denominator_g', 185694247,
    'converted_weeks', '17-26', 'converted_kg', 174958,
    'removed_duplicate', jsonb_build_object('week', 27, 'kg', 13691, 'duplicate_of', v_p3_w27),
    'farm_2026_kg_before', v_farm_before));

  insert into public.variety_conversion_rows (conversion_key, role, table_name, row_id, row_data)
  select k, 'original', 'yield_entries', e.id, to_jsonb(e) from public.yield_entries e where e.id in (select id from _expected_entries)
  union all
  select k, 'original', 'yield_entry_daily_breakdown', b.id, to_jsonb(b) from public.yield_entry_daily_breakdown b where b.id in (select id from _expected_breakdowns)
  union all
  select k, 'original', 'daily_yield_samples', s.id, jsonb_build_object('variety_id', s.variety_id) from public.daily_yield_samples s where s.variety_id = v_legacy
  union all
  select k, 'original', 'varieties', v.id, to_jsonb(v) from public.varieties v where v.id = v_legacy;

  -- ---------------------------------------------------------------- convert
  insert into public.yield_entries (id, organization_id, variety_id, year, week, packed_date, size_kg, total_kg,
                                    average_fruit_weight_g, kg_per_m2, total_cases, created_at, updated_at)
  select s.new_id, v_org, s.variety_id, 2026, s.week, legacy.packed_date, s.size_kg, s.total_kg,
         legacy.average_fruit_weight_g,
         case when v.area_m2 > 0 then s.total_kg / v.area_m2 else 0 end,
         case when v.case_kg > 0 then s.total_kg / v.case_kg else 0 end,
         legacy.created_at, now()
    from _split s
    join public.yield_entries legacy on legacy.id = s.legacy_id
    join public.varieties v on v.id = s.variety_id;

  insert into public.variety_conversion_rows (conversion_key, role, table_name, row_id)
  select k, 'generated', 'yield_entries', new_id from _split;

  with generated as (
    insert into public.yield_entry_daily_breakdown (organization_id, yield_entry_id, packed_date, size_kg, total_kg, average_fruit_weight_g, created_at, updated_at)
    select v_org, s.new_id, b.packed_date, bs.size_kg, bs.total_kg, b.average_fruit_weight_g, b.created_at, now()
      from _breakdown_split bs
      join public.yield_entry_daily_breakdown b on b.id = bs.breakdown_id
      join _split s on s.legacy_id = b.yield_entry_id and s.variety_id = bs.variety_id
    returning id
  )
  insert into public.variety_conversion_rows (conversion_key, role, table_name, row_id)
  select k, 'generated', 'yield_entry_daily_breakdown', id from generated;

  update public.daily_yield_samples
     set variety_id = case phase_id when v_phase2 then v_p2 when v_phase3 then v_p3 end
   where variety_id = v_legacy;

  delete from public.yield_entry_daily_breakdown where id in (select id from _expected_breakdowns);
  delete from public.yield_entries where id in (select id from _expected_entries);

  update public.varieties set status = 'inactive', updated_at = now() where id = v_legacy;

  -- ---------------------------------------------------------------- verify
  if exists (select 1 from public.yield_entries where variety_id = v_legacy)
     or exists (select 1 from public.daily_yield_samples where variety_id = v_legacy) then
    raise exception '0139: legacy Levente still has production records';
  end if;

  -- Every converted week and size bucket adds back to the original, exactly.
  if exists (
    select 1
      from _expected_entries x
      left join lateral (
        select sum(e.total_kg) as kg from public.yield_entries e
         where e.organization_id = v_org and e.variety_id in (v_p2, v_p3) and e.year = 2026 and e.week = x.week
      ) t on true
     where x.action = 'convert' and t.kg is distinct from x.total_kg
  ) then
    raise exception '0139: a converted week does not add back to its legacy total';
  end if;
  if exists (
    select 1
      from _expected_entries x, jsonb_each_text(x.size_kg) s
     where x.action = 'convert'
       and s.value::numeric <> (
         select coalesce(sum((e.size_kg ->> s.key)::numeric), 0) from public.yield_entries e
          where e.organization_id = v_org and e.variety_id in (v_p2, v_p3) and e.year = 2026 and e.week = x.week)
  ) then
    raise exception '0139: a converted size bucket does not add back to its legacy amount';
  end if;
  -- Breakdowns of each new entry add up to the entry.
  if exists (
    select 1 from _split s
     where s.total_kg <> coalesce((select sum(b.total_kg) from public.yield_entry_daily_breakdown b where b.yield_entry_id = s.new_id), s.total_kg)
  ) then
    raise exception '0139: a new entry''s daily breakdowns do not add up to it';
  end if;

  select coalesce(sum(total_kg), 0) into v_farm_after from public.yield_entries where organization_id = v_org and year = 2026;
  if v_farm_after <> v_farm_before - 13691 then
    raise exception '0139: 2026 farm total changed by % kg instead of -13,691 kg', v_farm_after - v_farm_before;
  end if;

  update public.variety_conversions set summary = summary || jsonb_build_object('farm_2026_kg_after', v_farm_after) where conversion_key = k;
end $$;
