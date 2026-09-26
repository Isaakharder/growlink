-- Migration 0138: variety_area_links — where a variety's yield physically
-- grew, for varieties that have no greenhouse row assignment of their own.
--
-- Physical growing area is the measured greenhouse rows (greenhouse_rows
-- width x length, grouped into greenhouse_groups phases). A variety's
-- footprint is normally its greenhouse_variety_assignments rows. A variety
-- recorded before it was split, renamed or replaced (e.g. one record later
-- divided into one record per phase) has yield but no rows: its rows now
-- belong to its successors. A link points such a variety at the footprint
-- its yield came from, so farm-wide kg/m2 can count its kg without adding
-- that area a second time:
--
--   successor_variety_id  the variety's yield came from the successor's rows
--                         (a continuation; several links = several successors)
--   greenhouse_group_id   the yield came from somewhere in this greenhouse
--                         group, rows unknown (a shared reporting area)
--
-- Exactly one target per link. Links only ever add footprint rows; the
-- denominator is the union of rows, so an area is never counted twice.
-- Server-only table (Express + service role), like 0137's hardened tables.

create table public.variety_area_links (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  variety_id            uuid not null references public.varieties(id) on delete cascade,
  successor_variety_id  uuid null references public.varieties(id) on delete cascade,
  greenhouse_group_id   uuid null references public.greenhouse_groups(id) on delete cascade,
  note                  text null,
  created_at            timestamptz not null default now(),
  created_by            uuid null,
  constraint variety_area_links_one_target
    check ((successor_variety_id is null) <> (greenhouse_group_id is null)),
  constraint variety_area_links_not_self
    check (successor_variety_id is null or successor_variety_id <> variety_id),
  constraint variety_area_links_successor_unique unique (variety_id, successor_variety_id),
  constraint variety_area_links_group_unique unique (variety_id, greenhouse_group_id)
);

create index variety_area_links_org_idx on public.variety_area_links (organization_id);

alter table public.variety_area_links enable row level security;

create policy variety_area_links_select_org on public.variety_area_links
  for select to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.variety_area_links to service_role;
