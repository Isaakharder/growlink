-- Migration 0153: a new yield size names its crop
--
-- 0152 kept a 'bell_pepper' default on yield_sizes.product_code so the
-- server deployed at the time (which adds sizes without a crop) kept
-- working. Every path of the server that follows 0152 sends the crop:
-- Setup -> Varieties (the selected crop), and the FlowMaster / CSV template
-- import paths ('bell_pepper', the crop they import). The default goes, so a
-- size added without a crop is refused instead of silently becoming a Bell
-- Peppers size.
--
-- Apply AFTER the server that follows 0152 is deployed. No row is changed.
-- Safe to run again.

begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'yield_sizes' and column_name = 'product_code'
  ) then
    raise exception '0153 aborted: migration 0152 (crop yield sizes) is not applied';
  end if;
end $$;

alter table public.yield_sizes alter column product_code drop default;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'yield_sizes' and column_name = 'product_code'
      and (column_default is not null or is_nullable <> 'NO')
  ) then
    raise exception '0153 aborted: yield_sizes.product_code still has a default or allows null';
  end if;
end $$;

commit;

-- ROLLBACK:
-- alter table public.yield_sizes alter column product_code set default 'bell_pepper';
