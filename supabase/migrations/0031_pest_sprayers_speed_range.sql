-- Make the legacy single-speed column optional so old rows stay intact
-- while new rows use the min/max range columns instead.
alter table public.pest_sprayers
  alter column speed_m_per_min drop not null;

-- Drop the 20–80 range constraint (no longer meaningful for a legacy column)
alter table public.pest_sprayers
  drop constraint if exists pest_sprayers_speed_m_per_min_check;

-- New speed range columns (all nullable; old rows leave them null)
alter table public.pest_sprayers
  add column if not exists min_speed_m_per_min numeric check (min_speed_m_per_min >= 0),
  add column if not exists max_speed_m_per_min numeric check (max_speed_m_per_min >= 0),
  add column if not exists speed_step_m_per_min numeric check (speed_step_m_per_min > 0);
