-- Extend status on pest_control_todos to include in_progress
alter table public.pest_control_todos
  drop constraint if exists pest_control_todos_status_check;

alter table public.pest_control_todos
  add constraint pest_control_todos_status_check
    check (status in ('pending', 'in_progress', 'completed', 'cancelled'));

-- Permanent record created when a todo is fully completed
create table if not exists public.pest_control_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  todo_id uuid references public.pest_control_todos(id) on delete set null,
  type text not null,
  chemical_id uuid,
  chemical_snapshot jsonb not null default '{}',
  target_snapshot jsonb not null default '{}',
  sprayer_snapshot jsonb not null default '{}',
  tank_snapshot jsonb not null default '{}',
  calculation_snapshot jsonb not null default '{}',
  progress_snapshot jsonb not null default '{}',
  completed_by uuid,
  completed_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists pest_control_records_organization_id_idx
  on public.pest_control_records (organization_id);

create index if not exists pest_control_records_todo_id_idx
  on public.pest_control_records (todo_id);

alter table public.pest_control_records enable row level security;

create policy pest_control_records_select_org on public.pest_control_records
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy pest_control_records_insert_org on public.pest_control_records
  for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy pest_control_records_update_org on public.pest_control_records
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy pest_control_records_delete_org on public.pest_control_records
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant all on table public.pest_control_records to anon, authenticated, service_role;
