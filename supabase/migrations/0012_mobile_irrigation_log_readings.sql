alter table public.mobile_irrigation_logs
  add column if not exists feed_valve_readings jsonb not null default '[]'::jsonb,
  add column if not exists drain_bucket_readings jsonb not null default '[]'::jsonb;
