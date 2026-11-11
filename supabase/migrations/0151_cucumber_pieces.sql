-- Migration 0151: Cucumbers can be counted in pieces
--
-- Adds Pieces (pcs) as a count unit and lets Cucumbers use it alongside kg.
-- An organization picks a crop's default unit in Setup → Products; that unit
-- applies to new harvests only. Bell Peppers stays kg only.
--
-- Piece counts are stored apart from weight, in yield_piece_entries: one row
-- per variety and week, beside (never inside) the kg row in yield_entries.
-- So a week can hold a kg harvest and a piece count for the same variety,
-- and nothing that reads kg (imports, CropLink, Pack History, Dashboard,
-- iOS) ever sees a count.
--
--   measurement_units      + Pieces (pcs), a count unit with no kg factor
--   catalog_product_units  + Cucumbers - pcs
--   yield_piece_entries    whole-number piece counts per variety and week
--
-- Database rules:
--   * a piece count belongs to its variety's organization, and its variety's
--     product must support pieces (so Bell Peppers can't be counted)
--   * a variety's product stays locked once it has piece counts, as 0149
--     already does for kg harvests
--
-- No existing row is changed: every organization's default unit stays what
-- it is (kg), and existing harvests stay kg.
--
-- Apply BEFORE deploying the server that offers Pieces: the old server never
-- reads the new table or offers the unit, so this is safe with it.
-- Safe to run again.

begin;

do $$
begin
  if not exists (select 1 from public.catalog_products where code = 'cucumber') then
    raise exception '0151 aborted: migration 0149 (Cucumbers) is not applied';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'varieties' and column_name = 'product_code'
      and column_default is not null
  ) then
    raise exception '0151 aborted: migration 0150 is not applied';
  end if;
end $$;

insert into public.measurement_units (code, name, dimension, kg_per_unit)
values ('pcs', 'Pieces', 'count', null)
on conflict (code) do nothing;

insert into public.catalog_product_units (product_code, unit_code)
values ('cucumber', 'pcs')
on conflict (product_code, unit_code) do nothing;

create table if not exists public.yield_piece_entries (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  variety_id       uuid not null references public.varieties(id),
  year             integer not null,
  week             integer not null check (week >= 1 and week <= 53),
  total_pieces     integer not null check (total_pieces >= 0),
  -- pieces over the variety's area when it was saved; null without an area
  pieces_per_m2    numeric null check (pieces_per_m2 >= 0),
  packed_date      date null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint yield_piece_entries_org_variety_year_week_key unique (organization_id, variety_id, year, week)
);

create index if not exists yield_piece_entries_org_year_week_idx
  on public.yield_piece_entries (organization_id, year desc, week desc);

-- A piece count is for a variety of the same organization whose product
-- supports pieces.
create or replace function public.yield_piece_entries_check_variety()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_product text;
begin
  select v.organization_id, v.product_code into v_org, v_product
  from public.varieties v
  where v.id = new.variety_id;
  if v_org is distinct from new.organization_id then
    raise exception 'A piece count must be for a variety of its own organization'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.catalog_product_units u where u.product_code = v_product and u.unit_code = 'pcs'
  ) then
    raise exception '% can''t be counted in pieces', coalesce((select name from public.catalog_products where code = v_product), 'This product')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists yield_piece_entries_check_variety on public.yield_piece_entries;
create trigger yield_piece_entries_check_variety
  before insert or update of variety_id, organization_id on public.yield_piece_entries
  for each row execute function public.yield_piece_entries_check_variety();

-- 0149's history lock, now counting piece counts as history too.
create or replace function public.varieties_product_locked_by_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_code is distinct from old.product_code and (
       exists (select 1 from public.yield_entries e where e.variety_id = old.id)
    or exists (select 1 from public.yield_piece_entries p where p.variety_id = old.id)
    or exists (select 1 from public.daily_yield_samples s where s.variety_id = old.id)
    or exists (select 1 from public.waste_imports w where w.variety_id = old.id)
  ) then
    raise exception 'This variety has recorded harvests, so its product can''t be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

alter table public.yield_piece_entries enable row level security;

revoke all on table public.yield_piece_entries from anon, authenticated, public;
grant select, insert, update, delete on table public.yield_piece_entries to service_role;

revoke all on function public.yield_piece_entries_check_variety(), public.varieties_product_locked_by_history()
  from anon, authenticated, public;

do $$
begin
  if not exists (select 1 from public.measurement_units where code = 'pcs' and dimension = 'count' and kg_per_unit is null) then
    raise exception '0151 aborted: Pieces is not a count unit';
  end if;
  if not exists (select 1 from public.catalog_product_units where product_code = 'cucumber' and unit_code = 'pcs')
     or not exists (select 1 from public.catalog_product_units where product_code = 'cucumber' and unit_code = 'kg') then
    raise exception '0151 aborted: Cucumbers does not support both kg and pcs';
  end if;
  if exists (select 1 from public.catalog_product_units where product_code = 'bell_pepper' and unit_code <> 'kg') then
    raise exception '0151 aborted: Bell Peppers must stay kg only';
  end if;
  if exists (select 1 from public.catalog_products where default_unit_code <> 'kg')
     or exists (select 1 from public.organization_products where default_unit_code <> 'kg' and product_code = 'bell_pepper') then
    raise exception '0151 aborted: a default unit changed';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.yield_piece_entries'::regclass) then
    raise exception '0151 aborted: row level security is off on public.yield_piece_entries';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'yield_piece_entries') then
    raise exception '0151 aborted: unexpected policy on public.yield_piece_entries';
  end if;
end $$;

commit;

-- ROLLBACK (only while no organization uses pieces: set every
-- organization_products.default_unit_code back to 'kg' and remove the piece
-- counts first):
-- begin;
-- create or replace function public.varieties_product_locked_by_history()
-- returns trigger language plpgsql security definer set search_path = public as $$
-- begin
--   if new.product_code is distinct from old.product_code and (
--        exists (select 1 from public.yield_entries e where e.variety_id = old.id)
--     or exists (select 1 from public.daily_yield_samples s where s.variety_id = old.id)
--     or exists (select 1 from public.waste_imports w where w.variety_id = old.id)
--   ) then
--     raise exception 'This variety has recorded harvests, so its product can''t be changed'
--       using errcode = 'check_violation';
--   end if;
--   return new;
-- end;
-- $$;
-- drop trigger if exists yield_piece_entries_check_variety on public.yield_piece_entries;
-- drop function if exists public.yield_piece_entries_check_variety();
-- drop table if exists public.yield_piece_entries;
-- delete from public.catalog_product_units where product_code = 'cucumber' and unit_code = 'pcs';
-- delete from public.measurement_units where code = 'pcs';
-- commit;
