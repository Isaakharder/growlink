-- Migration 0144: manual pack case entries (rebuilt Manual Add Case Entry)
--
-- Lets a user reconstruct shipment history per Product Pack from invoices,
-- including weeks before DockLink's pack capture started.
--
-- User-owned (never written, overwritten or zeroed by any DockLink sync):
--   historical_packs           packs from old invoices that DockLink no longer has
--   manual_pack_case_entries   one row per invoice line: ISO week, pack, shipped
--                              cases, optional invoice reference. Many rows may
--                              share a week and pack (several invoices).
--   case_week_sources          the explicit source chosen for a week that has both
--                              manual pack entries and legacy colour totals
--
-- pack_case_measurements (0143) is re-keyed from DockLink's series_key to the
-- pack and its ship-time classification, so one weekly measurement serves
-- imported and manual cases alike and no longer depends on series_key being
-- stable. series_key is kept, informational only.
--
-- All new tables are server-only, like 0143: RLS on with no policies, no
-- privileges for anon/authenticated/PUBLIC, service_role only. Asserted at the
-- end or rolled back. Existing tables other than pack_case_measurements are
-- not changed; color_case_entries is left exactly as it is.

begin;

-- ---------------------------------------------------------------------------
-- Historical packs (old invoice packs that no longer exist in DockLink)
-- ---------------------------------------------------------------------------

create table if not exists public.historical_packs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 120),
  pack_code        text check (pack_code is null or length(pack_code) <= 60),
  color_kind       text not null check (color_kind in ('single', 'mixed', 'none')),
  color_key        text not null default '',
  crop_type        text not null check (crop_type in ('pepper', 'cucumber', 'tomato', 'other')),
  tracking_unit    text not null check (tracking_unit in ('kg', 'case', 'piece', 'lb')),
  note             text check (note is null or length(note) <= 500),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint historical_packs_org_id_unique unique (organization_id, id),
  constraint historical_packs_color check (
    (color_kind = 'single' and color_key in ('red', 'orange', 'yellow', 'green'))
    or (color_kind = 'mixed' and color_key = 'mixed')
    or (color_kind = 'none' and color_key = '')
  )
);

alter table public.historical_packs enable row level security;

-- ---------------------------------------------------------------------------
-- Manual pack case entries
-- ---------------------------------------------------------------------------

create table if not exists public.manual_pack_case_entries (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  iso_year            integer not null check (iso_year between 2000 and 2100),
  iso_week            integer not null check (iso_week between 1 and 53),
  pack_source         text not null check (pack_source in ('docklink', 'historical')),
  docklink_pack_id    text,
  historical_pack_id  uuid,
  -- Classification and labels as entered (snapshot): later edits to the pack
  -- never reclassify an entry.
  pack_name           text not null,
  pack_code           text,
  color_kind          text not null check (color_kind in ('single', 'mixed', 'none')),
  color_key           text not null default '',
  crop_type           text not null,
  tracking_unit       text not null,
  cases               numeric not null check (cases > 0 and cases <= 1000000),
  invoice_ref         text check (invoice_ref is null or length(invoice_ref) between 1 and 100),
  invoice_ref_key     text generated always as (nullif(lower(btrim(invoice_ref)), '')) stored,
  note                text check (note is null or length(note) <= 500),
  created_by          uuid,
  updated_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint manual_pack_case_entries_pack check (
    (pack_source = 'docklink' and docklink_pack_id is not null and historical_pack_id is null)
    or (pack_source = 'historical' and historical_pack_id is not null and docklink_pack_id is null)
  ),
  -- Same organization as the pack, enforced by the keys themselves.
  constraint manual_pack_case_entries_docklink_pack foreign key (organization_id, docklink_pack_id)
    references public.docklink_packs (organization_id, pack_id) on delete restrict,
  constraint manual_pack_case_entries_historical_pack foreign key (organization_id, historical_pack_id)
    references public.historical_packs (organization_id, id) on delete restrict
);

create index if not exists manual_pack_case_entries_org_week_idx
  on public.manual_pack_case_entries (organization_id, iso_year, iso_week);
create index if not exists manual_pack_case_entries_org_invoice_idx
  on public.manual_pack_case_entries (organization_id, invoice_ref_key) where invoice_ref_key is not null;

alter table public.manual_pack_case_entries enable row level security;

-- ---------------------------------------------------------------------------
-- Explicit weekly source choice
-- ---------------------------------------------------------------------------

create table if not exists public.case_week_sources (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  iso_year         integer not null check (iso_year between 2000 and 2100),
  iso_week         integer not null check (iso_week between 1 and 53),
  source           text not null check (source in ('manual_packs', 'legacy_colours')),
  chosen_by        uuid,
  chosen_at        timestamptz not null default now(),
  primary key (organization_id, iso_year, iso_week)
);

alter table public.case_week_sources enable row level security;

-- ---------------------------------------------------------------------------
-- Measurements: keyed by pack + ship-time classification, not series_key
-- ---------------------------------------------------------------------------

alter table public.pack_case_measurements
  add column if not exists pack_source text not null default 'docklink';

alter table public.pack_case_measurements
  drop constraint if exists pack_case_measurements_pack_source_check;
alter table public.pack_case_measurements
  add constraint pack_case_measurements_pack_source_check check (pack_source in ('docklink', 'historical'));

-- Values are normalized (trimmed, lower case) so the identity below is exact.
update public.pack_case_measurements
   set color_key = lower(btrim(coalesce(color_key, ''))),
       crop_type = lower(btrim(crop_type)),
       tracking_unit = lower(btrim(tracking_unit));
alter table public.pack_case_measurements alter column color_key set default '';
alter table public.pack_case_measurements alter column color_key set not null;
alter table public.pack_case_measurements alter column series_key drop not null;

alter table public.pack_case_measurements drop constraint if exists pack_case_measurements_identity;
alter table public.pack_case_measurements drop constraint if exists pack_case_measurements_pack_identity;
alter table public.pack_case_measurements
  add constraint pack_case_measurements_pack_identity
  unique (organization_id, iso_year, iso_week, pack_source, pack_id, color_kind, color_key, crop_type, tracking_unit);

-- ---------------------------------------------------------------------------
-- Privileges: service_role only
-- ---------------------------------------------------------------------------

revoke all on table public.historical_packs         from anon, authenticated, public;
revoke all on table public.manual_pack_case_entries from anon, authenticated, public;
revoke all on table public.case_week_sources        from anon, authenticated, public;

grant select, insert, update, delete on table public.historical_packs         to service_role;
grant select, insert, update, delete on table public.manual_pack_case_entries to service_role;
grant select, insert, update, delete on table public.case_week_sources        to service_role;

do $$
declare
  t text;
  r text;
  p text;
begin
  foreach t in array array['historical_packs', 'manual_pack_case_entries', 'case_week_sources', 'pack_case_measurements'] loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, format('public.%I', t), p) then
          raise exception '0144 aborted: % still has % on public.%', r, p, t;
        end if;
      end loop;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', t), p) then
        raise exception '0144 aborted: service_role lacks % on public.%', p, t;
      end if;
    end loop;
    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      raise exception '0144 aborted: row level security is off on public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '0144 aborted: unexpected policy on public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ROLLBACK (drops only what this migration created; restores 0143's measurement key):
-- begin;
-- drop table if exists public.case_week_sources;
-- drop table if exists public.manual_pack_case_entries;
-- drop table if exists public.historical_packs;
-- delete from public.pack_case_measurements where pack_source <> 'docklink' or series_key is null;
-- alter table public.pack_case_measurements drop constraint if exists pack_case_measurements_pack_identity;
-- alter table public.pack_case_measurements alter column series_key set not null;
-- alter table public.pack_case_measurements alter column color_key drop not null;
-- alter table public.pack_case_measurements drop constraint if exists pack_case_measurements_pack_source_check;
-- alter table public.pack_case_measurements drop column if exists pack_source;
-- alter table public.pack_case_measurements add constraint pack_case_measurements_identity unique (organization_id, iso_year, iso_week, series_key);
-- commit;
