-- 0139_first_light_variety_area_links.sql
--
-- One-time variety_area_links for the First Light Greenhouses inc
-- organization, so its farm-wide kg/m2 counts every 2026 kg without counting
-- any greenhouse row twice (see 0138 and utils/varietyAreaFootprints.ts):
--
--   Levente  -> Levente Phase 2, Levente Phase 3   (continuation)
--     The single record used before the crop was split into one record per
--     phase. Its yield came from the Phase 2 + Phase 3 rows those successors
--     now hold; its kg is not split between the phases.
--   0699     -> Phase 2 greenhouse group            (shared reporting area)
--   0704     -> Phase 2 greenhouse group            (shared reporting area)
--     Trials grown inside Phase 2 rows already assigned to other varieties
--     (confirmed by the grower; nothing in the data records their rows).
--     Their kg joins the numerator; the rows are already in the denominator.
--
-- Records are identified by stable id and each is checked against its
-- expected organization, name and (for groups) type before anything is
-- written. Any mismatch, and any existing link from these varieties to a
-- different target, raises an exception so no wrong record is linked.
--
-- IDEMPOTENT: every insert is on conflict do nothing against 0138's unique
-- constraints, so running this again changes nothing.

do $$
declare
  v_org             constant uuid := 'e1b8a6cf-032c-48f0-852a-982dd58b9f9c';
  v_levente         constant uuid := 'd8f19f12-4b1b-4a14-b5b7-9aa3894478a1';
  v_levente_p2      constant uuid := 'd787404a-7334-4719-ae8c-1c45c4b7a10e';
  v_levente_p3      constant uuid := '8105bf4c-eb16-4415-812a-3b50f865fe8e';
  v_trial_0699      constant uuid := 'bddccdf4-b997-49de-b331-f411eba25606';
  v_trial_0704      constant uuid := '19e87a1c-2e0a-4652-b3ce-3564d0690a25';
  v_phase_2         constant uuid := '4044e9f5-f51c-49c6-ba6d-781f1821b857';
  v_expected        record;
  v_unexpected      integer;
begin
  if not exists (select 1 from public.organizations where id = v_org and name = 'First Light Greenhouses inc') then
    raise exception '0139: organization % ("First Light Greenhouses inc") not found', v_org;
  end if;

  for v_expected in
    select * from (values
      (v_levente,    'Levente'),
      (v_levente_p2, 'Levente Phase 2'),
      (v_levente_p3, 'Levente Phase 3'),
      (v_trial_0699, '0699'),
      (v_trial_0704, '0704')
    ) as t(id, name)
  loop
    if not exists (
      select 1 from public.varieties
       where id = v_expected.id and organization_id = v_org and trim(name) = v_expected.name
    ) then
      raise exception '0139: variety "%" (%) not found in organization %', v_expected.name, v_expected.id, v_org;
    end if;
  end loop;

  if not exists (
    select 1 from public.greenhouse_groups
     where id = v_phase_2 and organization_id = v_org and type = 'phase' and trim(name) = 'Phase 2'
  ) then
    raise exception '0139: greenhouse phase "Phase 2" (%) not found in organization %', v_phase_2, v_org;
  end if;

  -- An existing link from one of these varieties to anything other than the
  -- targets below would widen its footprint; refuse rather than add to it.
  select count(*) into v_unexpected
    from public.variety_area_links l
   where l.variety_id in (v_levente, v_trial_0699, v_trial_0704)
     and not (
       (l.variety_id = v_levente and l.successor_variety_id in (v_levente_p2, v_levente_p3))
       or (l.variety_id in (v_trial_0699, v_trial_0704) and l.greenhouse_group_id = v_phase_2)
     );
  if v_unexpected > 0 then
    raise exception '0139: % existing variety_area_links for Levente/0699/0704 point elsewhere; resolve them before applying', v_unexpected;
  end if;

  insert into public.variety_area_links (organization_id, variety_id, successor_variety_id, note)
  values
    (v_org, v_levente, v_levente_p2, 'Legacy record before the per-phase split'),
    (v_org, v_levente, v_levente_p3, 'Legacy record before the per-phase split')
  on conflict on constraint variety_area_links_successor_unique do nothing;

  insert into public.variety_area_links (organization_id, variety_id, greenhouse_group_id, note)
  values
    (v_org, v_trial_0699, v_phase_2, 'Trial grown inside assigned Phase 2 rows'),
    (v_org, v_trial_0704, v_phase_2, 'Trial grown inside assigned Phase 2 rows')
  on conflict on constraint variety_area_links_group_unique do nothing;
end $$;
