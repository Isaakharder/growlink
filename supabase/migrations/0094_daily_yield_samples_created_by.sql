alter table public.daily_yield_samples
  add column if not exists created_by uuid references auth.users(id);

create index if not exists daily_yield_samples_created_by_idx
  on public.daily_yield_samples (created_by);

grant select, insert, update, delete on table public.daily_yield_samples to service_role;
