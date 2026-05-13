alter table if exists public.greenhouse_variety_assignments
  add column if not exists assignment_pattern text;

-- Preserve existing records as legacy "all rows" behavior.
update public.greenhouse_variety_assignments
set assignment_pattern = 'all'
where assignment_pattern is null;

alter table if exists public.greenhouse_variety_assignments
  alter column assignment_pattern set default 'all';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'greenhouse_variety_assignments_assignment_pattern_check'
      and conrelid = 'public.greenhouse_variety_assignments'::regclass
  ) then
    alter table public.greenhouse_variety_assignments
      add constraint greenhouse_variety_assignments_assignment_pattern_check
      check (assignment_pattern is null or assignment_pattern in ('all', 'every_other'));
  end if;
end $$;
