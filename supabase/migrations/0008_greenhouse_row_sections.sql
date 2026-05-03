create table if not exists public.greenhouse_row_sections (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.greenhouse_groups(id) on delete cascade,
  start_row integer not null check (start_row >= 1),
  end_row integer not null check (end_row >= start_row),
  row_pattern text not null default 'all' check (row_pattern in ('all', 'odd', 'even')),
  slab_count integer not null default 0 check (slab_count >= 0),
  plants_per_slab integer not null default 0 check (plants_per_slab >= 0),
  stems_per_plant numeric not null default 1 check (stems_per_plant > 0),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.greenhouse_groups
  drop column if exists start_row,
  drop column if exists end_row;

alter table public.greenhouse_rows
  add column if not exists section_id uuid references public.greenhouse_row_sections(id) on delete set null;

delete from public.greenhouse_rows a
using public.greenhouse_rows b
where a.group_id = b.group_id
  and a.row_number = b.row_number
  and a.ctid < b.ctid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'greenhouse_rows_group_id_row_number_key'
  ) then
    alter table public.greenhouse_rows
      add constraint greenhouse_rows_group_id_row_number_key unique (group_id, row_number);
  end if;
end $$;

alter table public.greenhouse_row_sections enable row level security;

drop policy if exists greenhouse_row_sections_select_all on public.greenhouse_row_sections;
create policy greenhouse_row_sections_select_all on public.greenhouse_row_sections
  for select
  to public
  using (true);

drop policy if exists greenhouse_row_sections_insert_all on public.greenhouse_row_sections;
create policy greenhouse_row_sections_insert_all on public.greenhouse_row_sections
  for insert
  to public
  with check (true);

drop policy if exists greenhouse_row_sections_update_all on public.greenhouse_row_sections;
create policy greenhouse_row_sections_update_all on public.greenhouse_row_sections
  for update
  to public
  using (true)
  with check (true);

drop policy if exists greenhouse_row_sections_delete_all on public.greenhouse_row_sections;
create policy greenhouse_row_sections_delete_all on public.greenhouse_row_sections
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.greenhouse_row_sections to anon, authenticated, service_role;
