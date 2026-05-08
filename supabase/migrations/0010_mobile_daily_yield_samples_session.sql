alter table public.daily_yield_samples
  add column if not exists phase_id uuid,
  add column if not exists phase_name text,
  add column if not exists row_label text,
  add column if not exists row_number integer,
  add column if not exists percent_full numeric,
  add column if not exists kg_per_full_bin numeric,
  add column if not exists kg_per_case numeric,
  add column if not exists calculated_sample_kg numeric,
  add column if not exists calculated_kg_per_stem numeric,
  add column if not exists sample_date date,
  add column if not exists session_year integer,
  add column if not exists session_week integer;

update public.daily_yield_samples
set
  percent_full = coalesce(percent_full, bin_fill_percent),
  sample_date = coalesce(sample_date, created_at::date),
  session_year = coalesce(session_year, extract(year from created_at)::integer),
  session_week = coalesce(session_week, extract(week from created_at)::integer)
where
  percent_full is null
  or sample_date is null
  or session_year is null
  or session_week is null;

create index if not exists daily_yield_samples_variety_session_idx
  on public.daily_yield_samples (variety_id, session_year, session_week, sample_date);

-- TODO: Add organization_id scoping once a shared org isolation pattern is established.
