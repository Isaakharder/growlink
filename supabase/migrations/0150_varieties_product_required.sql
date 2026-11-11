-- Migration 0150: a new variety must name its product
--
-- 0148 gave varieties.product_code a constant 'bell_pepper' default so a
-- server deployed before products existed could still create varieties, and
-- said to remove it once a second product was added. With Cucumbers (0149)
-- that default would quietly make any variety created without a product a
-- Bell Pepper, so it goes: a missing product is now an error.
--
-- Apply AFTER the server that sends product_code on every variety create
-- (the Cucumbers release) is live. No row is updated; existing varieties keep
-- their product.
--
-- Safe to run again.

begin;

do $$
begin
  if not exists (select 1 from public.catalog_products where code = 'cucumber') then
    raise exception '0150 aborted: migration 0149 (Cucumbers) is not applied';
  end if;
end $$;

alter table public.varieties alter column product_code drop default;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'varieties' and column_name = 'product_code'
      and column_default is not null
  ) then
    raise exception '0150 aborted: varieties.product_code still has a default';
  end if;
end $$;

commit;

-- ROLLBACK:
-- alter table public.varieties alter column product_code set default 'bell_pepper';
