-- Add row width and length (meters) to greenhouse rows and sections.
-- Nullable so existing rows remain valid without requiring a default.
-- Must be positive when provided.

alter table if exists public.greenhouse_rows
  add column if not exists width_meters numeric,
  add column if not exists length_meters numeric;

alter table if exists public.greenhouse_row_sections
  add column if not exists width_meters numeric,
  add column if not exists length_meters numeric;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'greenhouse_rows_width_meters_check'
      and conrelid = 'public.greenhouse_rows'::regclass
  ) then
    alter table public.greenhouse_rows
      add constraint greenhouse_rows_width_meters_check
      check (width_meters is null or width_meters > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'greenhouse_rows_length_meters_check'
      and conrelid = 'public.greenhouse_rows'::regclass
  ) then
    alter table public.greenhouse_rows
      add constraint greenhouse_rows_length_meters_check
      check (length_meters is null or length_meters > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'greenhouse_row_sections_width_meters_check'
      and conrelid = 'public.greenhouse_row_sections'::regclass
  ) then
    alter table public.greenhouse_row_sections
      add constraint greenhouse_row_sections_width_meters_check
      check (width_meters is null or width_meters > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'greenhouse_row_sections_length_meters_check'
      and conrelid = 'public.greenhouse_row_sections'::regclass
  ) then
    alter table public.greenhouse_row_sections
      add constraint greenhouse_row_sections_length_meters_check
      check (length_meters is null or length_meters > 0);
  end if;
end $$;
