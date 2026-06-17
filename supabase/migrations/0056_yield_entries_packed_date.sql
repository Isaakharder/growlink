alter table public.yield_entries
  add column if not exists packed_date date;
