alter table public.daily_yield_bin_settings
  add column if not exists csv_size_settings jsonb null;
