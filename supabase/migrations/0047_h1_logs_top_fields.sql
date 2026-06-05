-- Add CanadaGAP H1 top-form and confirmation fields to food_safety_h1_logs.
-- All new columns are nullable so existing rows are unaffected.
alter table public.food_safety_h1_logs
  add column if not exists operation_name          text,
  add column if not exists current_crop            text,
  add column if not exists previous_year_crops     text,
  add column if not exists variety                 text,
  add column if not exists production_site_information text,
  add column if not exists production_site_area    text,
  add column if not exists date_planted            date,
  add column if not exists confirmation_signature  text,
  add column if not exists confirmation_date       date,
  add column if not exists version_label           text not null default 'Version 11.0';
