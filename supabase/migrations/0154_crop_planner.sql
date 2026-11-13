-- Migration 0154: Crop Planner
--
-- Draft plans for a season: which variety goes in which greenhouse row, and
-- which slab type each row gets, to work out how many seeds and slabs to
-- order. A plan is separate from the live greenhouse: nothing here reads or
-- writes greenhouse_variety_assignments, so planning next season never
-- changes what is growing today.
--
--   crop_plans                 one draft plan per organization, season and name
--   crop_plan_slab_types       the organization's slab types (reused across plans)
--   crop_plan_row_plantings    the variety planted in a row, per plan
--   crop_plan_row_slabs        the slab type of a row, per plan
--   crop_plan_row_layouts      planning inputs that override a row's layout
--                              (slabs per trough x troughs per row, plants per slab)
--   crop_plan_varieties        each variety's seed oversow percentage, per plan
--
-- A row is identified by its greenhouse group (phase) and row number, as
-- greenhouse_rows itself is, so a plan survives rows being regenerated from
-- their sections in Greenhouse Setup.
--
-- Rules the database enforces:
--   * one planting and one slab assignment per row per plan (unique keys)
--   * a plan's rows, varieties and slab types belong to the plan's organization
--
-- Access: service role only (RLS on, no policies), like 0151. The server
-- checks the organization on every request.
--
-- Adds tables only; no existing row is changed. Safe to run again.

begin;

create table if not exists public.crop_plans (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  season           text not null check (length(trim(season)) between 1 and 40),
  name             text not null check (length(trim(name)) between 1 and 120),
  notes            text null,
  status           text not null default 'draft' check (status in ('draft')),
  created_by       uuid null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint crop_plans_org_season_name_key unique (organization_id, season, name),
  constraint crop_plans_id_org_key unique (id, organization_id)
);

create table if not exists public.crop_plan_slab_types (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 120),
  status           text not null default 'active' check (status in ('active', 'inactive')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint crop_plan_slab_types_org_name_key unique (organization_id, name)
);

create table if not exists public.crop_plan_row_plantings (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null,
  organization_id  uuid not null,
  group_id         uuid not null references public.greenhouse_groups(id) on delete cascade,
  row_number       integer not null check (row_number >= 1),
  variety_id       uuid not null references public.varieties(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint crop_plan_row_plantings_plan_fkey foreign key (plan_id, organization_id)
    references public.crop_plans(id, organization_id) on delete cascade,
  constraint crop_plan_row_plantings_plan_row_key unique (plan_id, group_id, row_number)
);

create table if not exists public.crop_plan_row_slabs (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null,
  organization_id  uuid not null,
  group_id         uuid not null references public.greenhouse_groups(id) on delete cascade,
  row_number       integer not null check (row_number >= 1),
  slab_type_id     uuid not null references public.crop_plan_slab_types(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint crop_plan_row_slabs_plan_fkey foreign key (plan_id, organization_id)
    references public.crop_plans(id, organization_id) on delete cascade,
  constraint crop_plan_row_slabs_plan_row_key unique (plan_id, group_id, row_number)
);

create table if not exists public.crop_plan_row_layouts (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null,
  organization_id   uuid not null,
  group_id          uuid not null references public.greenhouse_groups(id) on delete cascade,
  row_number        integer not null check (row_number >= 1),
  slabs_per_trough  integer null check (slabs_per_trough > 0),
  troughs_per_row   integer null check (troughs_per_row > 0),
  plants_per_slab   integer null check (plants_per_slab > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint crop_plan_row_layouts_plan_fkey foreign key (plan_id, organization_id)
    references public.crop_plans(id, organization_id) on delete cascade,
  constraint crop_plan_row_layouts_plan_row_key unique (plan_id, group_id, row_number),
  -- slabs per row come from both trough inputs or from neither
  constraint crop_plan_row_layouts_troughs_paired check ((slabs_per_trough is null) = (troughs_per_row is null))
);

create table if not exists public.crop_plan_varieties (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null,
  organization_id  uuid not null,
  variety_id       uuid not null references public.varieties(id),
  oversow_pct      numeric(7,2) not null default 0 check (oversow_pct >= 0 and oversow_pct <= 1000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint crop_plan_varieties_plan_fkey foreign key (plan_id, organization_id)
    references public.crop_plans(id, organization_id) on delete cascade,
  constraint crop_plan_varieties_plan_variety_key unique (plan_id, variety_id)
);

create index if not exists crop_plans_org_idx on public.crop_plans (organization_id, season);
create index if not exists crop_plan_row_plantings_plan_idx on public.crop_plan_row_plantings (plan_id);
create index if not exists crop_plan_row_slabs_plan_idx on public.crop_plan_row_slabs (plan_id);
create index if not exists crop_plan_row_layouts_plan_idx on public.crop_plan_row_layouts (plan_id);

-- A plan's rows, varieties and slab types belong to the plan's organization.
create or replace function public.crop_plan_rows_match_organization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb := to_jsonb(new);
begin
  if v_payload ? 'group_id' and not exists (
    select 1 from public.greenhouse_groups g where g.id = (v_payload ->> 'group_id')::uuid and g.organization_id = new.organization_id
  ) then
    raise exception 'A plan row must be in a greenhouse group of the plan''s organization'
      using errcode = 'check_violation';
  end if;
  if v_payload ? 'variety_id' and not exists (
    select 1 from public.varieties v where v.id = (v_payload ->> 'variety_id')::uuid and v.organization_id = new.organization_id
  ) then
    raise exception 'A plan variety must belong to the plan''s organization'
      using errcode = 'check_violation';
  end if;
  if v_payload ? 'slab_type_id' and not exists (
    select 1 from public.crop_plan_slab_types s where s.id = (v_payload ->> 'slab_type_id')::uuid and s.organization_id = new.organization_id
  ) then
    raise exception 'A slab type must belong to the plan''s organization'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists crop_plan_row_plantings_match_org on public.crop_plan_row_plantings;
create trigger crop_plan_row_plantings_match_org
  before insert or update on public.crop_plan_row_plantings
  for each row execute function public.crop_plan_rows_match_organization();

drop trigger if exists crop_plan_row_slabs_match_org on public.crop_plan_row_slabs;
create trigger crop_plan_row_slabs_match_org
  before insert or update on public.crop_plan_row_slabs
  for each row execute function public.crop_plan_rows_match_organization();

drop trigger if exists crop_plan_row_layouts_match_org on public.crop_plan_row_layouts;
create trigger crop_plan_row_layouts_match_org
  before insert or update on public.crop_plan_row_layouts
  for each row execute function public.crop_plan_rows_match_organization();

drop trigger if exists crop_plan_varieties_match_org on public.crop_plan_varieties;
create trigger crop_plan_varieties_match_org
  before insert or update on public.crop_plan_varieties
  for each row execute function public.crop_plan_rows_match_organization();

revoke all on function public.crop_plan_rows_match_organization() from anon, authenticated, public;

alter table public.crop_plans enable row level security;
alter table public.crop_plan_slab_types enable row level security;
alter table public.crop_plan_row_plantings enable row level security;
alter table public.crop_plan_row_slabs enable row level security;
alter table public.crop_plan_row_layouts enable row level security;
alter table public.crop_plan_varieties enable row level security;

revoke all on table
  public.crop_plans, public.crop_plan_slab_types, public.crop_plan_row_plantings,
  public.crop_plan_row_slabs, public.crop_plan_row_layouts, public.crop_plan_varieties
  from anon, authenticated, public;
grant select, insert, update, delete on table
  public.crop_plans, public.crop_plan_slab_types, public.crop_plan_row_plantings,
  public.crop_plan_row_slabs, public.crop_plan_row_layouts, public.crop_plan_varieties
  to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['crop_plans', 'crop_plan_slab_types', 'crop_plan_row_plantings', 'crop_plan_row_slabs', 'crop_plan_row_layouts', 'crop_plan_varieties'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0154 aborted: row level security is off on public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '0154 aborted: unexpected policy on public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ROLLBACK (drops every plan):
-- begin;
-- drop table if exists public.crop_plan_varieties, public.crop_plan_row_layouts, public.crop_plan_row_slabs,
--   public.crop_plan_row_plantings, public.crop_plan_slab_types, public.crop_plans;
-- drop function if exists public.crop_plan_rows_match_organization();
-- commit;
