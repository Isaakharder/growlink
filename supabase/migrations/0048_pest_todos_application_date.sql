-- Planned application date for pest_control_todos.
-- Nullable so all existing rows remain valid without needing a backfill.
alter table public.pest_control_todos
  add column if not exists application_date date;
