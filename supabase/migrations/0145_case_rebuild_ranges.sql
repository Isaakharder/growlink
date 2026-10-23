-- Migration 0145: persistent historical rebuild ranges and week confirmations
--
-- A rebuild range is an explicit span of ISO weeks whose shipped totals come
-- from manual pack entries, whether or not anything has been entered yet.
-- Colour totals (color_case_entries) never count inside a range, so a later
-- DockLink colour sync can't bring them back. DockLink's authoritative pack
-- scope still takes precedence for any week it covers.
--
-- A week confirmation records that a manual week is complete: every invoice
-- has been entered, possibly none (a confirmed zero-shipment week). A manual
-- week with no entries and no confirmation is "not entered yet", which is
-- reported as incomplete — never as zero.
--
-- Both tables are user data (never written by a sync), server-only like 0143
-- and 0144, asserted at the end or rolled back.

begin;

create table if not exists public.case_rebuild_ranges (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_iso_year   integer not null check (from_iso_year between 2000 and 2100),
  from_iso_week   integer not null check (from_iso_week between 1 and 53),
  to_iso_year     integer not null check (to_iso_year between 2000 and 2100),
  to_iso_week     integer not null check (to_iso_week between 1 and 53),
  note            text check (note is null or length(note) <= 500),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint case_rebuild_ranges_order check ((from_iso_year * 100 + from_iso_week) <= (to_iso_year * 100 + to_iso_week))
);

create index if not exists case_rebuild_ranges_org_idx on public.case_rebuild_ranges (organization_id);

alter table public.case_rebuild_ranges enable row level security;

create table if not exists public.case_week_confirmations (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  iso_year        integer not null check (iso_year between 2000 and 2100),
  iso_week        integer not null check (iso_week between 1 and 53),
  note            text check (note is null or length(note) <= 500),
  confirmed_by    uuid,
  confirmed_at    timestamptz not null default now(),
  primary key (organization_id, iso_year, iso_week)
);

alter table public.case_week_confirmations enable row level security;

revoke all on table public.case_rebuild_ranges     from anon, authenticated, public;
revoke all on table public.case_week_confirmations from anon, authenticated, public;
grant select, insert, update, delete on table public.case_rebuild_ranges     to service_role;
grant select, insert, update, delete on table public.case_week_confirmations to service_role;

do $$
declare
  t text;
  r text;
  p text;
begin
  foreach t in array array['case_rebuild_ranges', 'case_week_confirmations'] loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, format('public.%I', t), p) then
          raise exception '0145 aborted: % still has % on public.%', r, p, t;
        end if;
      end loop;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', t), p) then
        raise exception '0145 aborted: service_role lacks % on public.%', p, t;
      end if;
    end loop;
    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      raise exception '0145 aborted: row level security is off on public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '0145 aborted: unexpected policy on public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ROLLBACK (drops only what this migration created):
-- begin;
-- drop table if exists public.case_week_confirmations;
-- drop table if exists public.case_rebuild_ranges;
-- commit;
