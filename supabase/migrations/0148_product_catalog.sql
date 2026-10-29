-- Migration 0148: GrowLink product catalog (Bell Peppers only)
--
-- Products come from a catalog only GrowLink controls (this and later
-- migrations); organizations enable catalog products, pick a supported
-- default unit, and attach their varieties to an enabled product.
--
--   measurement_units      units GrowLink supports: kg only for now
--   catalog_products       official products and their capabilities:
--                          Bell Peppers (bell_pepper), tracks_colour on
--   catalog_product_units  which units each product supports: Bell Peppers - kg
--   organization_products  products each organization has enabled, with its
--                          default unit and status: Bell Peppers, kg, active
--                          for every organization, and for new organizations
--                          automatically (organizations insert trigger)
--   varieties.product_code the variety's product; every existing variety is
--                          bell_pepper through the column default, so no
--                          existing row is updated and no historical record
--                          changes
--
-- Rules the database enforces:
--   * a default unit must be one its product supports
--   * a variety belongs to a product its own organization has enabled
--     (composite foreign key; a product with varieties can't be removed)
--   * an organization keeps at least one active product
--   * a product with active varieties can't be deactivated, and a variety
--     can't be active while its product is inactive
--
-- Units: existing records and anything sent without a unit are kg. Nothing
-- here stores or reinterprets units on production records.
--
-- New tables are server-only like 0143-0146: RLS on, no policies, no
-- privileges for anon/authenticated/PUBLIC, service_role only.
--
-- Safe to run again: every step is "if not exists" / "on conflict do
-- nothing" / guarded, and a second run changes nothing. The checks at the end
-- roll everything back unless the end state holds.

begin;

do $$
begin
  if exists (select 1 from public.varieties where organization_id is null) then
    raise exception '0148 aborted: a variety has no organization';
  end if;
end $$;

create table if not exists public.measurement_units (
  code         text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  name         text not null,
  dimension    text not null check (dimension in ('weight', 'count')),
  -- exact kg per unit for weight units; count units have none
  kg_per_unit  numeric null check (kg_per_unit > 0),
  constraint measurement_units_weight_factor check ((dimension = 'weight') = (kg_per_unit is not null))
);

create table if not exists public.catalog_products (
  code                           text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  name                           text not null unique,
  -- capabilities: one typed column each, added with the code that uses it
  tracks_colour                  boolean not null default false,
  -- the crop_type the pack tables (DockLink, historical packs) use for it
  pack_crop_type                 text null,
  -- the unit an organization starts with when the product is enabled
  default_unit_code              text not null,
  enabled_for_new_organizations  boolean not null default false,
  created_at                     timestamptz not null default now()
);

create table if not exists public.catalog_product_units (
  product_code  text not null references public.catalog_products(code) on delete restrict,
  unit_code     text not null references public.measurement_units(code) on delete restrict,
  primary key (product_code, unit_code)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_products_default_unit_supported') then
    alter table public.catalog_products
      add constraint catalog_products_default_unit_supported
      foreign key (code, default_unit_code) references public.catalog_product_units (product_code, unit_code)
      deferrable initially deferred;
  end if;
end $$;

insert into public.measurement_units (code, name, dimension, kg_per_unit)
values ('kg', 'Kilograms', 'weight', 1)
on conflict (code) do nothing;

insert into public.catalog_products (code, name, tracks_colour, pack_crop_type, default_unit_code, enabled_for_new_organizations)
values ('bell_pepper', 'Bell Peppers', true, 'pepper', 'kg', true)
on conflict (code) do nothing;

insert into public.catalog_product_units (product_code, unit_code)
values ('bell_pepper', 'kg')
on conflict (product_code, unit_code) do nothing;

-- Check the default-unit link now rather than at commit, so the tables can
-- still be altered below.
set constraints public.catalog_products_default_unit_supported immediate;

create table if not exists public.organization_products (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  product_code       text not null references public.catalog_products(code) on delete restrict,
  default_unit_code  text not null,
  status             text not null default 'active' check (status in ('active', 'inactive')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint organization_products_org_product_key unique (organization_id, product_code),
  constraint organization_products_supported_unit foreign key (product_code, default_unit_code)
    references public.catalog_product_units (product_code, unit_code) on delete restrict
);

insert into public.organization_products (organization_id, product_code, default_unit_code)
select o.id, c.code, c.default_unit_code
from public.organizations o
cross join public.catalog_products c
where c.enabled_for_new_organizations
on conflict (organization_id, product_code) do nothing;

-- A constant default fills existing rows without updating them (no row is
-- rewritten and no trigger fires). It also keeps variety creation working
-- for a server deployed before this migration's code. Remove it when a
-- second product is added, so a missing product is an error, not Bell Peppers.
alter table public.varieties add column if not exists product_code text not null default 'bell_pepper';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'varieties_organization_product_fkey') then
    alter table public.varieties
      add constraint varieties_organization_product_fkey
      foreign key (organization_id, product_code) references public.organization_products (organization_id, product_code)
      on delete restrict;
  end if;
end $$;

create index if not exists varieties_org_product_idx on public.varieties (organization_id, product_code);

-- New organizations get every product the catalog enables for them.
create or replace function public.organization_products_enable_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_products (organization_id, product_code, default_unit_code)
  select new.id, c.code, c.default_unit_code
  from public.catalog_products c
  where c.enabled_for_new_organizations
  on conflict (organization_id, product_code) do nothing;
  return new;
end;
$$;

-- An organization keeps at least one active product, a product with active
-- varieties stays active, and a row never moves to another organization or
-- product. Removing the organization itself (cascade) is allowed.
create or replace function public.organization_products_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and (new.organization_id <> old.organization_id or new.product_code <> old.product_code) then
    raise exception 'An organization product cannot move to another organization or product'
      using errcode = 'check_violation';
  end if;

  if old.status = 'active'
     and (tg_op = 'DELETE' or new.status <> 'active')
     and exists (select 1 from public.organizations o where o.id = old.organization_id) then
    if not exists (
      select 1 from public.organization_products p
      where p.organization_id = old.organization_id and p.id <> old.id and p.status = 'active'
    ) then
      raise exception 'An organization must keep at least one active product'
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from public.varieties v
      where v.organization_id = old.organization_id and v.product_code = old.product_code and v.status = 'active'
    ) then
      raise exception 'A product with active varieties cannot be deactivated'
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- An active variety needs an active product in its own organization.
create or replace function public.varieties_require_active_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' and not exists (
    select 1 from public.organization_products p
    where p.organization_id = new.organization_id and p.product_code = new.product_code and p.status = 'active'
  ) then
    raise exception 'An active variety needs an active product for its organization'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_enable_default_products on public.organizations;
create trigger organizations_enable_default_products
  after insert on public.organizations
  for each row execute function public.organization_products_enable_defaults();

drop trigger if exists organization_products_guard on public.organization_products;
create trigger organization_products_guard
  before update or delete on public.organization_products
  for each row execute function public.organization_products_guard();

drop trigger if exists varieties_require_active_product on public.varieties;
create trigger varieties_require_active_product
  before insert or update of status, product_code, organization_id on public.varieties
  for each row execute function public.varieties_require_active_product();

alter table public.measurement_units enable row level security;
alter table public.catalog_products enable row level security;
alter table public.catalog_product_units enable row level security;
alter table public.organization_products enable row level security;

revoke all on table public.measurement_units, public.catalog_products, public.catalog_product_units, public.organization_products
  from anon, authenticated, public;
grant select, insert, update, delete on table public.measurement_units, public.catalog_products, public.catalog_product_units, public.organization_products
  to service_role;
revoke all on function public.organization_products_enable_defaults(), public.organization_products_guard(), public.varieties_require_active_product()
  from anon, authenticated, public;

do $$
declare
  t text;
  r text;
  p text;
begin
  if exists (
    select 1 from public.varieties v
    where not exists (
      select 1 from public.organization_products op
      where op.organization_id = v.organization_id and op.product_code = v.product_code
    )
  ) then
    raise exception '0148 aborted: a variety has no enabled product';
  end if;
  if exists (
    select 1 from public.organizations o
    where not exists (select 1 from public.organization_products op where op.organization_id = o.id and op.status = 'active')
  ) then
    raise exception '0148 aborted: an organization has no active product';
  end if;
  if not exists (
    select 1 from public.catalog_products
    where code = 'bell_pepper' and name = 'Bell Peppers' and tracks_colour and default_unit_code = 'kg'
  ) or not exists (select 1 from public.measurement_units where code = 'kg' and dimension = 'weight' and kg_per_unit = 1) then
    raise exception '0148 aborted: the catalog does not hold Bell Peppers in kg';
  end if;

  foreach t in array array['measurement_units', 'catalog_products', 'catalog_product_units', 'organization_products'] loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, 'public.' || t, p) then
          raise exception '0148 aborted: % still has % on public.%', r, p, t;
        end if;
      end loop;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.' || t, p) then
        raise exception '0148 aborted: service_role lacks % on public.%', p, t;
      end if;
    end loop;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0148 aborted: row level security is off on public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '0148 aborted: unexpected policy on public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ROLLBACK (removes only what this migration added; no existing row is touched):
-- begin;
-- drop trigger if exists varieties_require_active_product on public.varieties;
-- drop trigger if exists organizations_enable_default_products on public.organizations;
-- alter table public.varieties drop constraint if exists varieties_organization_product_fkey;
-- drop index if exists public.varieties_org_product_idx;
-- alter table public.varieties drop column if exists product_code;
-- drop table if exists public.organization_products;
-- drop table if exists public.catalog_product_units, public.catalog_products;
-- drop table if exists public.measurement_units;
-- drop function if exists public.varieties_require_active_product();
-- drop function if exists public.organization_products_guard();
-- drop function if exists public.organization_products_enable_defaults();
-- commit;
