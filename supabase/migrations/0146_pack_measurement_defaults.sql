-- Migration 0146: remembered pack measurements ("Remember for future weeks")
--
-- A remembered measurement is an optional default for one organization, pack
-- and ship-time classification (the same identity as pack_case_measurements:
-- pack_source, pack_id, color_kind, color_key, crop_type, tracking_unit). A
-- week with no measurement of its own uses the default in effect for that
-- week, for imported and manual cases alike; a week's own measurement always
-- wins and is never written by anything here.
--
-- Defaults are versioned by the ISO week they take effect from. Remembering,
-- changing or forgetting at week W writes the version for W only, so every
-- week before W keeps the value it had (nothing is recalculated backwards)
-- and a version already set for a later week still takes over from that
-- week. Forgetting writes a tombstone (forgotten = true) rather than deleting,
-- so an earlier version can't silently come back into effect for W onward.
--
-- value_kind separates what can be remembered independently:
--   net_kg         single-colour packs: average net pepper kg per shipping case
--   counts         rainbow packs: peppers per shipping case, per colour
--                  ([{color, pieces_per_case}])
--   fruit_weights  rainbow packs: average fruit weight (g), per colour
--                  ([{color, fruit_weight_g}])
-- so a rainbow pack's counts can stay fixed while its fruit weights change.
--
-- User data (never written by a sync), server-only like 0143-0145: RLS on,
-- no policies, no privileges for anon/authenticated/PUBLIC, service_role
-- only; asserted at the end or rolled back. No existing table is changed.

begin;

create or replace function public.pack_measurement_default_values_valid(p_kind text, p_components jsonb)
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
        and case p_kind
          when 'counts' then jsonb_typeof(c -> 'pieces_per_case') = 'number' and (c ->> 'pieces_per_case')::numeric > 0 and not (c ? 'fruit_weight_g')
          when 'fruit_weights' then jsonb_typeof(c -> 'fruit_weight_g') = 'number' and (c ->> 'fruit_weight_g')::numeric > 0 and not (c ? 'pieces_per_case')
          else false
        end
      )
      from jsonb_array_elements(p_components) c
    )
    and (select count(distinct c ->> 'color') from jsonb_array_elements(p_components) c) = jsonb_array_length(p_components)
$$;

create table if not exists public.pack_measurement_defaults (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  pack_source             text not null check (pack_source in ('docklink', 'historical')),
  pack_id                 text not null check (length(pack_id) > 0),
  color_kind              text not null check (color_kind in ('single', 'mixed')),
  color_key               text not null default '',
  crop_type               text not null,
  tracking_unit           text not null,
  value_kind              text not null check (value_kind in ('net_kg', 'counts', 'fruit_weights')),
  effective_from_iso_year integer not null check (effective_from_iso_year between 2000 and 2100),
  effective_from_iso_week integer not null check (effective_from_iso_week between 1 and 53),
  forgotten               boolean not null default false,
  net_kg_per_case         numeric check (net_kg_per_case > 0),
  components              jsonb,
  updated_by              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- stored normalized, exactly as pack_case_measurements' identity
  constraint pack_measurement_defaults_normalized check (
    color_key = lower(btrim(color_key)) and crop_type = lower(btrim(crop_type)) and tracking_unit = lower(btrim(tracking_unit))
  ),
  constraint pack_measurement_defaults_kind check (
    (value_kind = 'net_kg' and color_kind = 'single') or (value_kind in ('counts', 'fruit_weights') and color_kind = 'mixed')
  ),
  constraint pack_measurement_defaults_shape check (
    (forgotten and net_kg_per_case is null and components is null)
    or (not forgotten and value_kind = 'net_kg' and net_kg_per_case is not null and components is null)
    or (not forgotten and value_kind in ('counts', 'fruit_weights') and net_kg_per_case is null and components is not null
        and public.pack_measurement_default_values_valid(value_kind, components))
  ),
  -- one version per identity, value kind and effective week (the upsert target)
  constraint pack_measurement_defaults_version unique (
    organization_id, pack_source, pack_id, color_kind, color_key, crop_type, tracking_unit, value_kind,
    effective_from_iso_year, effective_from_iso_week
  )
);

alter table public.pack_measurement_defaults enable row level security;

revoke all on table public.pack_measurement_defaults from anon, authenticated, public;
grant select, insert, update, delete on table public.pack_measurement_defaults to service_role;
revoke all on function public.pack_measurement_default_values_valid(text, jsonb) from anon, authenticated, public;
grant execute on function public.pack_measurement_default_values_valid(text, jsonb) to service_role;

do $$
declare
  r text;
  p text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(r, 'public.pack_measurement_defaults', p) then
        raise exception '0146 aborted: % still has % on public.pack_measurement_defaults', r, p;
      end if;
    end loop;
    if has_function_privilege(r, 'public.pack_measurement_default_values_valid(text, jsonb)', 'EXECUTE') then
      raise exception '0146 aborted: % can execute public.pack_measurement_default_values_valid', r;
    end if;
  end loop;
  foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', 'public.pack_measurement_defaults', p) then
      raise exception '0146 aborted: service_role lacks % on public.pack_measurement_defaults', p;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.pack_measurement_defaults'::regclass) then
    raise exception '0146 aborted: row level security is off on public.pack_measurement_defaults';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pack_measurement_defaults') then
    raise exception '0146 aborted: unexpected policy on public.pack_measurement_defaults';
  end if;
end $$;

commit;

-- ROLLBACK (drops only what this migration created; week measurements are untouched):
-- begin;
-- drop table if exists public.pack_measurement_defaults;
-- drop function if exists public.pack_measurement_default_values_valid(text, jsonb);
-- commit;
