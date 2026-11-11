-- Migration 0152: yield sizes belong to a crop
--
-- Until now an organization had one size list, used by Bell Peppers. Each
-- crop now has its own list, with its own names and sort order, so
-- Cucumbers can be sized without touching the pepper sizes.
--
--   yield_sizes.product_code        the crop the size belongs to. Every
--                                   existing size is a Bell Peppers size:
--                                   its id, name, sort order and status are
--                                   unchanged, so pepper history and imports
--                                   read exactly as before.
--   unique (org, crop, name)        replaces unique (org, name): the same
--                                   name ("Large") can exist once per crop.
--   yield_piece_entries.size_pieces whole-number piece counts per size
--                                   (sizeId -> count), beside total_pieces.
--
-- An entry's sizes need not add up to its total. A harvest recorded as a
-- total only, later combined in the same week with a sized harvest, keeps
-- the difference (total - sum of sizes) as its unsized amount, so the weekly
-- total stays what was harvested. Kg and pieces stay apart as in 0151.
--
-- Rules the database enforces from here on:
--   * a size key on a kg harvest (yield_entries.size_kg) or a piece count
--     (yield_piece_entries.size_pieces) is a size of the entry's own
--     organization and of its variety's crop. A key already on the entry is
--     kept as it is while the crop is the same, so a retired size, or a size
--     removed before this migration, stays readable on old harvests.
--   * piece counts per size are whole numbers of 0 or more, and add up to no
--     more than the entry's total_pieces
--   * a size's crop can't be changed
--   * a size on recorded harvests can't be deleted; it is retired by setting
--     it inactive instead
--
-- 0149's rule that Cucumbers harvests carry no size buckets is replaced by
-- the first rule: a crop's harvests may use that crop's sizes only. Cucumbers
-- has no sizes until an organization adds some in Setup -> Varieties.
--
-- Existing rows: no harvest, variety or size is changed apart from
-- yield_sizes.product_code being filled in as 'bell_pepper'.
--
-- product_code keeps a 'bell_pepper' default for now, so the server already
-- deployed (which adds sizes without a crop) keeps working until the new
-- server is deployed. 0153 removes the default after that deploy.
--
-- Apply BEFORE deploying the server that offers per-crop sizes.
-- Safe to run again.

begin;

do $$
begin
  if to_regclass('public.yield_piece_entries') is null then
    raise exception '0152 aborted: migration 0151 (cucumber pieces) is not applied';
  end if;
end $$;

create temporary table _0152_sizes_before on commit drop as
  select id, organization_id, name, sort_order, status from public.yield_sizes;

-- 1. Every size belongs to a crop; every existing size is a Bell Peppers size.
alter table public.yield_sizes add column if not exists product_code text;
alter table public.yield_sizes alter column product_code set default 'bell_pepper';
update public.yield_sizes set product_code = 'bell_pepper' where product_code is null;
alter table public.yield_sizes alter column product_code set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'yield_sizes_product_code_fkey') then
    alter table public.yield_sizes
      add constraint yield_sizes_product_code_fkey foreign key (product_code) references public.catalog_products(code);
  end if;
end $$;

-- 2. A size name is unique within its crop, not across the organization.
alter table public.yield_sizes drop constraint if exists yield_sizes_org_name_key;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'yield_sizes_org_product_name_key') then
    alter table public.yield_sizes
      add constraint yield_sizes_org_product_name_key unique (organization_id, product_code, name);
  end if;
end $$;

create index if not exists yield_sizes_org_product_sort_idx
  on public.yield_sizes (organization_id, product_code, sort_order);

-- 3. Piece counts per size.
alter table public.yield_piece_entries add column if not exists size_pieces jsonb not null default '{}'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'yield_piece_entries_size_pieces_object') then
    alter table public.yield_piece_entries
      add constraint yield_piece_entries_size_pieces_object check (jsonb_typeof(size_pieces) = 'object');
  end if;
end $$;

-- 4. A harvest's size keys are sizes of its own organization and crop.
--    Shared by kg harvests and piece counts.
create or replace function public.yield_size_keys_match_crop(
  p_organization_id uuid,
  p_variety_id uuid,
  p_sizes jsonb,
  p_old_variety_id uuid,
  p_old_sizes jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product text;
  v_old_product text;
  v_key text;
begin
  if p_sizes is null or p_sizes = '{}'::jsonb then
    return;
  end if;
  select v.product_code into v_product from public.varieties v where v.id = p_variety_id;
  if p_old_variety_id is not null then
    select v.product_code into v_old_product from public.varieties v where v.id = p_old_variety_id;
  end if;
  for v_key in select jsonb_object_keys(p_sizes) loop
    -- Already on this harvest, for the same crop: kept as it is (a retired
    -- size, or one removed before 0152, stays readable).
    if p_old_sizes is not null and v_old_product is not distinct from v_product and p_old_sizes ? v_key then
      continue;
    end if;
    if v_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not exists (
      select 1 from public.yield_sizes s
      where s.id = v_key::uuid and s.organization_id = p_organization_id and s.product_code = v_product
    ) then
      raise exception 'Size % is not one of the % sizes of this organization', v_key,
        coalesce((select name from public.catalog_products where code = v_product), 'crop''s')
        using errcode = 'check_violation';
    end if;
  end loop;
end;
$$;

-- Replaces 0149's "a product without sizes carries no size buckets".
create or replace function public.yield_entries_sizes_match_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    perform public.yield_size_keys_match_crop(new.organization_id, new.variety_id, new.size_kg, old.variety_id, old.size_kg);
  else
    perform public.yield_size_keys_match_crop(new.organization_id, new.variety_id, new.size_kg, null, null);
  end if;
  return new;
end;
$$;

-- The trigger itself is 0149's (before insert or update of size_kg,
-- variety_id on yield_entries); only its function changes.

create or replace function public.yield_piece_entries_sizes_match_crop()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum numeric := 0;
  v_value jsonb;
begin
  for v_value in select value from jsonb_each(new.size_pieces) loop
    if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 0
       or (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric) then
      raise exception 'Pieces per size must be whole numbers of 0 or more'
        using errcode = 'check_violation';
    end if;
    v_sum := v_sum + (v_value #>> '{}')::numeric;
  end loop;
  -- (a negative total is refused by the total_pieces check itself)
  if new.total_pieces >= 0 and v_sum > new.total_pieces then
    raise exception 'Pieces per size add up to more than the total pieces'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' then
    perform public.yield_size_keys_match_crop(new.organization_id, new.variety_id, new.size_pieces, old.variety_id, old.size_pieces);
  else
    perform public.yield_size_keys_match_crop(new.organization_id, new.variety_id, new.size_pieces, null, null);
  end if;
  return new;
end;
$$;

drop trigger if exists yield_piece_entries_sizes_match_crop on public.yield_piece_entries;
create trigger yield_piece_entries_sizes_match_crop
  before insert or update of size_pieces, total_pieces, variety_id on public.yield_piece_entries
  for each row execute function public.yield_piece_entries_sizes_match_crop();

-- 5. A size keeps its crop.
create or replace function public.yield_sizes_product_locked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_code is distinct from old.product_code then
    raise exception 'A size''s crop can''t be changed; add the size to the other crop instead'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists yield_sizes_product_locked on public.yield_sizes;
create trigger yield_sizes_product_locked
  before update of product_code on public.yield_sizes
  for each row execute function public.yield_sizes_product_locked();

-- 6. A size on recorded harvests is retired (inactive), not deleted. A
--    delete cascading from another table (pg_trigger_depth() > 1, e.g. an
--    organization being removed) is not blocked.
create or replace function public.yield_sizes_keep_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  if exists (select 1 from public.yield_entries e where e.organization_id = old.organization_id and e.size_kg ? old.id::text)
     or exists (select 1 from public.yield_entry_daily_breakdown b where b.organization_id = old.organization_id and b.size_kg ? old.id::text)
     or exists (select 1 from public.yield_piece_entries p where p.organization_id = old.organization_id and p.size_pieces ? old.id::text) then
    raise exception 'This size is on recorded harvests. Set it to Inactive to retire it; its history stays readable.'
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists yield_sizes_keep_history on public.yield_sizes;
create trigger yield_sizes_keep_history
  before delete on public.yield_sizes
  for each row execute function public.yield_sizes_keep_history();

revoke all on function
  public.yield_size_keys_match_crop(uuid, uuid, jsonb, uuid, jsonb),
  public.yield_entries_sizes_match_product(),
  public.yield_piece_entries_sizes_match_crop(),
  public.yield_sizes_product_locked(),
  public.yield_sizes_keep_history()
  from anon, authenticated, public;

grant select, insert, update, delete on table public.yield_sizes to service_role;
grant select, insert, update, delete on table public.yield_piece_entries to service_role;

do $$
begin
  if exists (select 1 from public.yield_sizes where product_code is null) then
    raise exception '0152 aborted: a size has no crop';
  end if;
  -- Every size that existed before this migration is unchanged.
  if exists (
    select 1 from _0152_sizes_before b
    left join public.yield_sizes s on s.id = b.id
    where s.id is null or s.organization_id <> b.organization_id or s.name <> b.name
       or s.sort_order <> b.sort_order or s.status <> b.status
  ) then
    raise exception '0152 aborted: an existing size changed';
  end if;
  if exists (select 1 from pg_constraint where conname = 'yield_sizes_org_name_key')
     or not exists (select 1 from pg_constraint where conname = 'yield_sizes_org_product_name_key') then
    raise exception '0152 aborted: size names are not unique per crop';
  end if;
  -- Bell Peppers harvests use Bell Peppers sizes only; no other crop's
  -- harvest has a size of another crop.
  if exists (
    select 1
    from public.yield_entries e
    join public.varieties v on v.id = e.variety_id
    cross join lateral jsonb_object_keys(e.size_kg) k(key)
    join public.yield_sizes s on s.id::text = k.key
    where s.product_code <> v.product_code or s.organization_id <> e.organization_id
  ) then
    raise exception '0152 aborted: a harvest has a size of another crop or organization';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.yield_sizes'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.yield_piece_entries'::regclass) then
    raise exception '0152 aborted: row level security is off';
  end if;
end $$;

commit;

-- ROLLBACK (only while every size is a Bell Peppers size and no piece count
-- has sizes: delete other crops' sizes and clear size_pieces first):
-- begin;
-- drop trigger if exists yield_sizes_keep_history on public.yield_sizes;
-- drop trigger if exists yield_sizes_product_locked on public.yield_sizes;
-- drop trigger if exists yield_piece_entries_sizes_match_crop on public.yield_piece_entries;
-- drop function if exists public.yield_sizes_keep_history();
-- drop function if exists public.yield_sizes_product_locked();
-- drop function if exists public.yield_piece_entries_sizes_match_crop();
-- create or replace function public.yield_entries_sizes_match_product()
-- returns trigger language plpgsql security definer set search_path = public as $$
-- declare
--   v_tracks_sizes boolean;
-- begin
--   if new.size_kg is null or new.size_kg = '{}'::jsonb then
--     return new;
--   end if;
--   select c.tracks_sizes into v_tracks_sizes
--   from public.varieties v
--   join public.catalog_products c on c.code = v.product_code
--   where v.id = new.variety_id;
--   if v_tracks_sizes = false then
--     raise exception 'A harvest for this product is a total kg without size buckets'
--       using errcode = 'check_violation';
--   end if;
--   return new;
-- end;
-- $$;
-- drop function if exists public.yield_size_keys_match_crop(uuid, uuid, jsonb, uuid, jsonb);
-- alter table public.yield_piece_entries drop constraint if exists yield_piece_entries_size_pieces_object;
-- alter table public.yield_piece_entries drop column if exists size_pieces;
-- drop index if exists public.yield_sizes_org_product_sort_idx;
-- alter table public.yield_sizes drop constraint if exists yield_sizes_org_product_name_key;
-- alter table public.yield_sizes add constraint yield_sizes_org_name_key unique (organization_id, name);
-- alter table public.yield_sizes drop constraint if exists yield_sizes_product_code_fkey;
-- alter table public.yield_sizes drop column if exists product_code;
-- commit;
