-- Migration 0143: DockLink pack shipments (contract docklink.growlink.pack_export v1)
--
-- Replaces colour-only case imports, for weeks DockLink declares
-- authoritative, with weekly shipped counts per configured Product Pack.
-- Shipped kg is then calculated from measurements entered in GrowLink.
--
-- DockLink-owned (written only by apply_docklink_pack_export, server-side):
--   docklink_pack_sync_state         one row per organization: contract, scope, diagnostics
--   docklink_packs                   the pack catalogue (never deleted; archived packs kept)
--   docklink_pack_weekly_shipments   weekly shipped cases per series, keyed by
--                                    (organization, iso_year, iso_week, series_key)
-- User-owned (never written or deleted by a sync):
--   pack_case_measurements           weekly measurements per series, with a snapshot of the
--                                    ship-time classification they were entered against
--
-- All four are server-only: RLS on with no policies, no privileges for
-- anon/authenticated/PUBLIC, service_role only. The two functions are
-- executable by service_role only. Asserted at the end or rolled back.
-- Nothing here changes existing tables; color_case_entries (legacy colour
-- totals and manual entries) is left exactly as it is.

begin;

-- ---------------------------------------------------------------------------
-- Sync state
-- ---------------------------------------------------------------------------

create table if not exists public.docklink_pack_sync_state (
  organization_id          uuid primary key references public.organizations(id) on delete cascade,
  external_organization_id text not null,
  contract                 text not null check (contract = 'docklink.growlink.pack_export'),
  contract_version         integer not null check (contract_version = 1),
  generated_at             timestamptz not null,
  week_rule                text,
  scope_status             text not null check (scope_status in ('available', 'pending_first_full_week', 'capture_not_active')),
  capture_activated_at     timestamptz,
  transition_iso_year      integer,
  transition_iso_week      integer check (transition_iso_week between 1 and 53),
  first_iso_year           integer,
  first_iso_week           integer check (first_iso_week between 1 and 53),
  last_iso_year            integer,
  last_iso_week            integer check (last_iso_week between 1 and 53),
  diagnostics              jsonb not null default '{}'::jsonb,
  last_synced_at           timestamptz not null default now(),
  constraint docklink_pack_sync_state_scope_weeks check (
    scope_status <> 'available'
    or (first_iso_year is not null and first_iso_week is not null and last_iso_year is not null and last_iso_week is not null
        and (first_iso_year * 100 + first_iso_week) <= (last_iso_year * 100 + last_iso_week))
  )
);

alter table public.docklink_pack_sync_state enable row level security;

-- ---------------------------------------------------------------------------
-- Pack catalogue
-- ---------------------------------------------------------------------------

create table if not exists public.docklink_packs (
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  pack_id              text not null check (length(pack_id) > 0),
  name                 text not null,
  pack_code            text,
  description          text,
  color_label          text,
  color_key            text,
  color_kind           text,
  display_order        numeric,
  crop_type            text,
  tracking_unit        text,
  status               text not null,
  archived_at          timestamptz,
  docklink_updated_at  timestamptz,
  -- false once a later export no longer lists the pack (kept for history, never deleted)
  in_latest_export     boolean not null default true,
  first_seen_at        timestamptz not null default now(),
  last_synced_at       timestamptz not null default now(),
  primary key (organization_id, pack_id)
);

alter table public.docklink_packs enable row level security;

-- ---------------------------------------------------------------------------
-- Weekly shipments per series (series = pack + its ship-time classification)
-- ---------------------------------------------------------------------------

create table if not exists public.docklink_pack_weekly_shipments (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  iso_year              integer not null,
  iso_week              integer not null check (iso_week between 1 and 53),
  week_start            date not null,
  series_key            text not null check (length(series_key) > 0),
  attribution           text not null check (attribution in ('pack', 'unattributed')),
  pack_id               text,
  source_pack_ref       text,
  pack_name             text,
  pack_code             text,
  color_key             text,
  color_kind            text,
  crop_type             text,
  tracking_unit         text,
  total_cases           numeric not null check (total_cases >= 0),
  load_count            integer not null default 0 check (load_count >= 0),
  line_count            integer not null default 0 check (line_count >= 0),
  -- true when this series is in scope but was absent from the latest export (set to 0 by reconciliation)
  absent_from_export    boolean not null default false,
  first_seen_at         timestamptz not null default now(),
  last_synced_at        timestamptz not null default now(),
  constraint docklink_pack_weekly_shipments_identity unique (organization_id, iso_year, iso_week, series_key),
  constraint docklink_pack_weekly_shipments_attribution check (
    (attribution = 'pack' and pack_id is not null) or (attribution = 'unattributed' and pack_id is null)
  )
);

create index if not exists docklink_pack_weekly_shipments_org_week_idx
  on public.docklink_pack_weekly_shipments (organization_id, iso_year, iso_week);

alter table public.docklink_pack_weekly_shipments enable row level security;

-- ---------------------------------------------------------------------------
-- User measurements (never touched by a sync)
-- ---------------------------------------------------------------------------

-- components: [{ "color": "red"|"orange"|"yellow"|"green", "pieces_per_case": >0, "fruit_weight_g": >0 }, ...]
-- one entry per colour, at least one entry.
create or replace function public.pack_measurement_components_valid(p_components jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_typeof(p_components) = 'array'
    and jsonb_array_length(p_components) between 1 and 4
    and (
      select bool_and(
        jsonb_typeof(c) = 'object'
        and (c ->> 'color') in ('red', 'orange', 'yellow', 'green')
        and jsonb_typeof(c -> 'pieces_per_case') = 'number' and (c ->> 'pieces_per_case')::numeric > 0
        and jsonb_typeof(c -> 'fruit_weight_g') = 'number' and (c ->> 'fruit_weight_g')::numeric > 0
      )
      from jsonb_array_elements(p_components) c
    )
    and (select count(distinct c ->> 'color') from jsonb_array_elements(p_components) c) = jsonb_array_length(p_components)
$$;

create table if not exists public.pack_case_measurements (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  iso_year                 integer not null,
  iso_week                 integer not null check (iso_week between 1 and 53),
  series_key               text not null check (length(series_key) > 0),
  -- ship-time classification this measurement was entered against; a series
  -- whose classification differs never uses it
  pack_id                  text not null,
  color_kind               text not null check (color_kind in ('single', 'mixed')),
  color_key                text,
  crop_type                text not null,
  tracking_unit            text not null,
  -- single-colour packs: average net pepper kg per shipping case
  net_kg_per_case          numeric check (net_kg_per_case > 0),
  -- mixed packs: per colour, peppers per shipping case and average fruit weight (g)
  components               jsonb,
  copied_from_iso_year     integer,
  copied_from_iso_week     integer check (copied_from_iso_week between 1 and 53),
  updated_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pack_case_measurements_identity unique (organization_id, iso_year, iso_week, series_key),
  constraint pack_case_measurements_shape check (
    (color_kind = 'single' and net_kg_per_case is not null and components is null and color_key is not null)
    or (color_kind = 'mixed' and net_kg_per_case is null and components is not null
        and public.pack_measurement_components_valid(components))
  ),
  constraint pack_case_measurements_copied_from check (
    (copied_from_iso_year is null) = (copied_from_iso_week is null)
  )
);

alter table public.pack_case_measurements enable row level security;

-- ---------------------------------------------------------------------------
-- Atomic apply of one validated export
-- ---------------------------------------------------------------------------
--
-- p_export is the server's normalized form of a validated
-- growlink_pack_export_v1 document:
--   { contract, version, organization_id, generated_at, week_rule,
--     scope: { status, capture_activated_at, transition_week, first_week, last_week },
--     packs: [...], weekly_pack_totals: [...], diagnostics: {...} }
-- (weeks as { iso_year, iso_week, week_start }). Everything below runs in
-- the caller's single transaction: any error leaves every table unchanged.

create or replace function public.apply_docklink_pack_export(
  p_organization_id uuid,
  p_external_organization_id text,
  p_export jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_status        text := p_export #>> '{scope,status}';
  v_generated_at  timestamptz := (p_export ->> 'generated_at')::timestamptz;
  v_previous      public.docklink_pack_sync_state%rowtype;
  v_first         integer;
  v_last          integer;
  v_packs         integer := 0;
  v_inserted      integer := 0;
  v_updated       integer := 0;
  v_zeroed        integer := 0;
  v_dupes         integer;
begin
  if p_export ->> 'contract' is distinct from 'docklink.growlink.pack_export' then
    raise exception 'unsupported contract %', p_export ->> 'contract' using errcode = '22023';
  end if;
  if (p_export ->> 'version') is distinct from '1' then
    raise exception 'unsupported contract version %', p_export ->> 'version' using errcode = '22023';
  end if;
  if lower(p_export ->> 'organization_id') is distinct from lower(p_external_organization_id) then
    raise exception 'export organization does not match the mapped DockLink organization' using errcode = '22023';
  end if;
  if v_status is null or v_status not in ('available', 'pending_first_full_week', 'capture_not_active') then
    raise exception 'unsupported scope status %', v_status using errcode = '22023';
  end if;

  -- Serialize syncs per organization and refuse an export older than the one already applied.
  perform pg_advisory_xact_lock(hashtextextended('docklink_pack_export:' || p_organization_id::text, 0));
  select * into v_previous from public.docklink_pack_sync_state where organization_id = p_organization_id;
  if found and v_previous.generated_at > v_generated_at then
    raise exception 'stale export: generated_at % is older than the last applied export (%)', v_generated_at, v_previous.generated_at
      using errcode = '40001';
  end if;

  if v_status = 'available' then
    v_first := (p_export #>> '{scope,first_week,iso_year}')::int * 100 + (p_export #>> '{scope,first_week,iso_week}')::int;
    v_last  := (p_export #>> '{scope,last_week,iso_year}')::int * 100 + (p_export #>> '{scope,last_week,iso_week}')::int;
    if v_first is null or v_last is null or v_first > v_last then
      raise exception 'available scope requires first_week <= last_week' using errcode = '22023';
    end if;

    select count(*) - count(distinct (r ->> 'iso_year', r ->> 'iso_week', r ->> 'series_key')) into v_dupes
      from jsonb_array_elements(coalesce(p_export -> 'weekly_pack_totals', '[]'::jsonb)) r;
    if v_dupes > 0 then
      raise exception 'export repeats a (iso_year, iso_week, series_key) identity' using errcode = '22023';
    end if;

    if exists (
      select 1 from jsonb_array_elements(coalesce(p_export -> 'weekly_pack_totals', '[]'::jsonb)) r
      where (r ->> 'iso_year')::int * 100 + (r ->> 'iso_week')::int not between v_first and v_last
    ) then
      raise exception 'export contains weekly totals outside its authoritative scope' using errcode = '22023';
    end if;
  end if;

  insert into public.docklink_pack_sync_state as s (
    organization_id, external_organization_id, contract, contract_version, generated_at, week_rule,
    scope_status, capture_activated_at,
    transition_iso_year, transition_iso_week, first_iso_year, first_iso_week, last_iso_year, last_iso_week,
    diagnostics, last_synced_at
  ) values (
    p_organization_id, p_external_organization_id, p_export ->> 'contract', (p_export ->> 'version')::int, v_generated_at,
    p_export ->> 'week_rule', v_status, (p_export #>> '{scope,capture_activated_at}')::timestamptz,
    (p_export #>> '{scope,transition_week,iso_year}')::int, (p_export #>> '{scope,transition_week,iso_week}')::int,
    (p_export #>> '{scope,first_week,iso_year}')::int, (p_export #>> '{scope,first_week,iso_week}')::int,
    (p_export #>> '{scope,last_week,iso_year}')::int, (p_export #>> '{scope,last_week,iso_week}')::int,
    coalesce(p_export -> 'diagnostics', '{}'::jsonb), now()
  )
  on conflict (organization_id) do update set
    external_organization_id = excluded.external_organization_id,
    contract = excluded.contract, contract_version = excluded.contract_version,
    generated_at = excluded.generated_at, week_rule = excluded.week_rule,
    scope_status = excluded.scope_status, capture_activated_at = excluded.capture_activated_at,
    transition_iso_year = excluded.transition_iso_year, transition_iso_week = excluded.transition_iso_week,
    first_iso_year = excluded.first_iso_year, first_iso_week = excluded.first_iso_week,
    last_iso_year = excluded.last_iso_year, last_iso_week = excluded.last_iso_week,
    diagnostics = excluded.diagnostics, last_synced_at = excluded.last_synced_at;

  -- Catalogue: upsert every listed pack; packs no longer listed are kept, flagged.
  insert into public.docklink_packs as p (
    organization_id, pack_id, name, pack_code, description, color_label, color_key, color_kind,
    display_order, crop_type, tracking_unit, status, archived_at, docklink_updated_at, in_latest_export, last_synced_at
  )
  select p_organization_id, x ->> 'pack_id', x ->> 'name', x ->> 'pack_code', x ->> 'description', x ->> 'color_label',
         x ->> 'color_key', x ->> 'color_kind', (x ->> 'display_order')::numeric, x ->> 'crop_type', x ->> 'tracking_unit',
         x ->> 'status', (x ->> 'archived_at')::timestamptz, (x ->> 'updated_at')::timestamptz, true, now()
    from jsonb_array_elements(coalesce(p_export -> 'packs', '[]'::jsonb)) x
  on conflict (organization_id, pack_id) do update set
    name = excluded.name, pack_code = excluded.pack_code, description = excluded.description,
    color_label = excluded.color_label, color_key = excluded.color_key, color_kind = excluded.color_kind,
    display_order = excluded.display_order, crop_type = excluded.crop_type, tracking_unit = excluded.tracking_unit,
    status = excluded.status, archived_at = excluded.archived_at, docklink_updated_at = excluded.docklink_updated_at,
    in_latest_export = true, last_synced_at = excluded.last_synced_at;
  get diagnostics v_packs = row_count;

  update public.docklink_packs set in_latest_export = false
   where organization_id = p_organization_id
     and in_latest_export
     and pack_id not in (select x ->> 'pack_id' from jsonb_array_elements(coalesce(p_export -> 'packs', '[]'::jsonb)) x);

  -- Weekly counts are reconciled only when DockLink declares a scope authoritative.
  -- A pending or not-active export leaves every stored series (and every measurement) untouched.
  if v_status = 'available' then
    with incoming as (
      select r from jsonb_array_elements(coalesce(p_export -> 'weekly_pack_totals', '[]'::jsonb)) r
    ), upserted as (
      insert into public.docklink_pack_weekly_shipments as w (
        organization_id, iso_year, iso_week, week_start, series_key, attribution, pack_id, source_pack_ref,
        pack_name, pack_code, color_key, color_kind, crop_type, tracking_unit,
        total_cases, load_count, line_count, absent_from_export, last_synced_at
      )
      select p_organization_id, (r ->> 'iso_year')::int, (r ->> 'iso_week')::int, (r ->> 'week_start')::date,
             r ->> 'series_key', r ->> 'attribution', r ->> 'pack_id', r ->> 'source_pack_ref',
             r ->> 'pack_name', r ->> 'pack_code', r ->> 'color_key', r ->> 'color_kind', r ->> 'crop_type', r ->> 'tracking_unit',
             (r ->> 'total_cases')::numeric, coalesce((r ->> 'load_count')::int, 0), coalesce((r ->> 'line_count')::int, 0),
             false, now()
        from incoming
      on conflict (organization_id, iso_year, iso_week, series_key) do update set
        week_start = excluded.week_start, attribution = excluded.attribution, pack_id = excluded.pack_id,
        source_pack_ref = excluded.source_pack_ref, pack_name = excluded.pack_name, pack_code = excluded.pack_code,
        color_key = excluded.color_key, color_kind = excluded.color_kind, crop_type = excluded.crop_type,
        tracking_unit = excluded.tracking_unit, total_cases = excluded.total_cases, load_count = excluded.load_count,
        line_count = excluded.line_count, absent_from_export = false, last_synced_at = excluded.last_synced_at
      returning (xmax = 0) as inserted
    )
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_inserted, v_updated from upserted;

    -- Missing within the authoritative scope means zero (a void, or corrected away).
    update public.docklink_pack_weekly_shipments w
       set total_cases = 0, load_count = 0, line_count = 0, absent_from_export = true, last_synced_at = now()
     where w.organization_id = p_organization_id
       and (w.iso_year * 100 + w.iso_week) between v_first and v_last
       and not exists (
         select 1 from jsonb_array_elements(coalesce(p_export -> 'weekly_pack_totals', '[]'::jsonb)) r
          where (r ->> 'iso_year')::int = w.iso_year and (r ->> 'iso_week')::int = w.iso_week and r ->> 'series_key' = w.series_key
       )
       and (w.total_cases <> 0 or not w.absent_from_export);
    get diagnostics v_zeroed = row_count;
  end if;

  return jsonb_build_object(
    'scope_status', v_status,
    'packs', v_packs,
    'series_inserted', v_inserted,
    'series_updated', v_updated,
    'series_zeroed', v_zeroed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: service_role only
-- ---------------------------------------------------------------------------

revoke all on table public.docklink_pack_sync_state       from anon, authenticated, public;
revoke all on table public.docklink_packs                 from anon, authenticated, public;
revoke all on table public.docklink_pack_weekly_shipments from anon, authenticated, public;
revoke all on table public.pack_case_measurements         from anon, authenticated, public;

grant select, insert, update, delete on table public.docklink_pack_sync_state       to service_role;
grant select, insert, update, delete on table public.docklink_packs                 to service_role;
grant select, insert, update, delete on table public.docklink_pack_weekly_shipments to service_role;
grant select, insert, update, delete on table public.pack_case_measurements         to service_role;

revoke all on function public.apply_docklink_pack_export(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.pack_measurement_components_valid(jsonb)       from public, anon, authenticated;
grant execute on function public.apply_docklink_pack_export(uuid, text, jsonb) to service_role;
grant execute on function public.pack_measurement_components_valid(jsonb)       to service_role;

do $$
declare
  t text;
  r text;
  p text;
begin
  foreach t in array array['docklink_pack_sync_state', 'docklink_packs', 'docklink_pack_weekly_shipments', 'pack_case_measurements'] loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, format('public.%I', t), p) then
          raise exception '0143 aborted: % still has % on public.%', r, p, t;
        end if;
      end loop;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', t), p) then
        raise exception '0143 aborted: service_role lacks % on public.%', p, t;
      end if;
    end loop;
    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      raise exception '0143 aborted: row level security is off on public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '0143 aborted: unexpected policy on public.%', t;
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.apply_docklink_pack_export(uuid, text, jsonb)', 'EXECUTE') then
      raise exception '0143 aborted: % can execute apply_docklink_pack_export', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.apply_docklink_pack_export(uuid, text, jsonb)', 'EXECUTE') then
    raise exception '0143 aborted: service_role cannot execute apply_docklink_pack_export';
  end if;
end $$;

commit;

-- ROLLBACK (drops only what this migration created; no existing data is touched):
-- begin;
-- drop function if exists public.apply_docklink_pack_export(uuid, text, jsonb);
-- drop table if exists public.pack_case_measurements;
-- drop table if exists public.docklink_pack_weekly_shipments;
-- drop table if exists public.docklink_packs;
-- drop table if exists public.docklink_pack_sync_state;
-- drop function if exists public.pack_measurement_components_valid(jsonb);
-- commit;
