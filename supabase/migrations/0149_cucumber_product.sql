-- Migration 0149: Cucumbers, GrowLink's second catalog product
--
-- Builds on 0148 (product catalog). Adds:
--
--   catalog_products.tracks_sizes  capability: the product's harvests are
--                                  recorded per yield size bucket. Bell
--                                  Peppers: on. Cucumbers: off — a cucumber
--                                  harvest is a total kg only.
--   Cucumbers (cucumber)           kg is its only and default unit, no colour,
--                                  no sizes. Not enabled for any existing
--                                  organization and not for new ones: an
--                                  organization's admin enables it in
--                                  Setup → Products.
--   varieties.color nullable       a cucumber variety stores no colour. The
--                                  'red' default goes too, so a variety that
--                                  needs a colour has to be given one.
--
-- Rules the database enforces from here on:
--   * a variety has a colour exactly when its product tracks colour
--     (Bell Peppers: one of red/orange/yellow/green, as before; Cucumbers: null)
--   * a variety's product can't change once it has recorded harvests (yield
--     entries, daily yield samples or waste imports), so no historical harvest
--     is relabelled as another crop
--   * a yield entry for a product without sizes carries no size buckets
--
-- Existing rows: no variety, yield entry or other production row is updated.
-- Every existing variety is Bell Peppers with a colour, so it already
-- satisfies the new rules (checked below). The one catalog row updated is
-- Bell Peppers' own tracks_sizes capability.
--
-- Compatible with the server already deployed (it always sends a colour and
-- never changes a variety's product), so apply this BEFORE deploying the
-- server that offers Cucumbers. 0150 follows the server deploy.
--
-- Safe to run again: every step is "if not exists" / "on conflict do
-- nothing" / guarded, and a second run changes nothing. The checks at the end
-- roll everything back unless the end state holds.

begin;

do $$
begin
  if to_regclass('public.catalog_products') is null
     or not exists (select 1 from public.catalog_products where code = 'bell_pepper') then
    raise exception '0149 aborted: migration 0148 (product catalog) is not applied';
  end if;
end $$;

alter table public.catalog_products add column if not exists tracks_sizes boolean not null default false;

update public.catalog_products set tracks_sizes = true where code = 'bell_pepper' and not tracks_sizes;

insert into public.catalog_products (code, name, tracks_colour, tracks_sizes, pack_crop_type, default_unit_code, enabled_for_new_organizations)
values ('cucumber', 'Cucumbers', false, false, 'cucumber', 'kg', false)
on conflict (code) do nothing;

insert into public.catalog_product_units (product_code, unit_code)
values ('cucumber', 'kg')
on conflict (product_code, unit_code) do nothing;

-- The existing check (color in red/orange/yellow/green) still applies to every
-- colour that is stored; null passes it.
alter table public.varieties alter column color drop not null;
alter table public.varieties alter column color drop default;

-- A variety has a colour exactly when its product tracks colour.
create or replace function public.varieties_colour_matches_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tracks_colour boolean;
begin
  select c.tracks_colour into v_tracks_colour from public.catalog_products c where c.code = new.product_code;
  if v_tracks_colour is null then
    -- Unknown product: the organization_products foreign key reports it.
    return new;
  end if;
  if v_tracks_colour and new.color is null then
    raise exception 'A % variety needs a colour', (select name from public.catalog_products where code = new.product_code)
      using errcode = 'check_violation';
  end if;
  if not v_tracks_colour and new.color is not null then
    raise exception 'A % variety has no colour', (select name from public.catalog_products where code = new.product_code)
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- A variety with recorded harvests keeps its product.
create or replace function public.varieties_product_locked_by_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_code is distinct from old.product_code and (
       exists (select 1 from public.yield_entries e where e.variety_id = old.id)
    or exists (select 1 from public.daily_yield_samples s where s.variety_id = old.id)
    or exists (select 1 from public.waste_imports w where w.variety_id = old.id)
  ) then
    raise exception 'This variety has recorded harvests, so its product can''t be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- A yield entry for a product without sizes is a total kg with no size buckets.
create or replace function public.yield_entries_sizes_match_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tracks_sizes boolean;
begin
  if new.size_kg is null or new.size_kg = '{}'::jsonb then
    return new;
  end if;
  select c.tracks_sizes into v_tracks_sizes
  from public.varieties v
  join public.catalog_products c on c.code = v.product_code
  where v.id = new.variety_id;
  if v_tracks_sizes = false then
    raise exception 'A harvest for this product is a total kg without size buckets'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists varieties_colour_matches_product on public.varieties;
create trigger varieties_colour_matches_product
  before insert or update of color, product_code on public.varieties
  for each row execute function public.varieties_colour_matches_product();

drop trigger if exists varieties_product_locked_by_history on public.varieties;
create trigger varieties_product_locked_by_history
  before update of product_code on public.varieties
  for each row execute function public.varieties_product_locked_by_history();

drop trigger if exists yield_entries_sizes_match_product on public.yield_entries;
create trigger yield_entries_sizes_match_product
  before insert or update of size_kg, variety_id on public.yield_entries
  for each row execute function public.yield_entries_sizes_match_product();

revoke all on function public.varieties_colour_matches_product(), public.varieties_product_locked_by_history(), public.yield_entries_sizes_match_product()
  from anon, authenticated, public;

do $$
begin
  if not exists (
    select 1 from public.catalog_products
    where code = 'cucumber' and name = 'Cucumbers' and not tracks_colour and not tracks_sizes
      and default_unit_code = 'kg' and not enabled_for_new_organizations
  ) or not exists (select 1 from public.catalog_product_units where product_code = 'cucumber' and unit_code = 'kg') then
    raise exception '0149 aborted: the catalog does not hold Cucumbers in kg';
  end if;
  if not exists (select 1 from public.catalog_products where code = 'bell_pepper' and tracks_colour and tracks_sizes) then
    raise exception '0149 aborted: Bell Peppers lost its colour or size capability';
  end if;
  if exists (
    select 1 from public.varieties v join public.catalog_products c on c.code = v.product_code
    where c.tracks_colour <> (v.color is not null)
  ) then
    raise exception '0149 aborted: a variety''s colour does not match its product';
  end if;
  if exists (
    select 1 from public.yield_entries e
    join public.varieties v on v.id = e.variety_id
    join public.catalog_products c on c.code = v.product_code
    where not c.tracks_sizes and e.size_kg <> '{}'::jsonb
  ) then
    raise exception '0149 aborted: a yield entry has size buckets its product does not track';
  end if;
  if (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'varieties' and column_name = 'color') <> 'YES' then
    raise exception '0149 aborted: varieties.color is still not null';
  end if;
end $$;

commit;

-- ROLLBACK (only valid while no variety has a null colour, i.e. before any
-- cucumber variety exists; remove cucumber varieties and their harvests first):
-- begin;
-- drop trigger if exists yield_entries_sizes_match_product on public.yield_entries;
-- drop trigger if exists varieties_product_locked_by_history on public.varieties;
-- drop trigger if exists varieties_colour_matches_product on public.varieties;
-- drop function if exists public.yield_entries_sizes_match_product();
-- drop function if exists public.varieties_product_locked_by_history();
-- drop function if exists public.varieties_colour_matches_product();
-- alter table public.varieties alter column color set default 'red';
-- alter table public.varieties alter column color set not null;
-- delete from public.organization_products where product_code = 'cucumber';
-- delete from public.catalog_product_units where product_code = 'cucumber';
-- delete from public.catalog_products where code = 'cucumber';
-- alter table public.catalog_products drop column if exists tracks_sizes;
-- commit;
