alter table public.pest_control_todos
  add column if not exists progress_snapshot jsonb not null default '{}';
