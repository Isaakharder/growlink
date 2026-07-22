-- Food Safety, first real feature after the module reset: cleaning locations
-- and the recurring cleaning tasks configured for each one.
--
-- food_safety_cleaning_locations: a physical location/room that requires
-- routine cleaning (e.g. "Lower Lunch Room").
--
-- food_safety_cleaning_tasks: the individual cleaning tasks required at a
-- location, each with its own frequency, since different tasks at the same
-- location can run on different schedules (e.g. floor swept daily, floor
-- washed weekly).
--
-- This is setup/configuration only — no completion records, checklists, or
-- sign-off workflow yet. Those are later phases that will read from these
-- two tables to generate the actual cleaning checklists.

create table if not exists public.food_safety_cleaning_locations (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  name            text        not null,
  area            text        not null,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid        references auth.users(id) on delete set null,
  constraint food_safety_cleaning_locations_org_name_key unique (organization_id, name)
);

create index if not exists food_safety_cleaning_locations_org_idx
  on public.food_safety_cleaning_locations (organization_id);

create index if not exists food_safety_cleaning_locations_org_active_idx
  on public.food_safety_cleaning_locations (organization_id, is_active);

alter table public.food_safety_cleaning_locations enable row level security;

drop policy if exists food_safety_cleaning_locations_select_org on public.food_safety_cleaning_locations;
create policy food_safety_cleaning_locations_select_org on public.food_safety_cleaning_locations
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_locations_insert_org on public.food_safety_cleaning_locations;
create policy food_safety_cleaning_locations_insert_org on public.food_safety_cleaning_locations
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_locations_update_org on public.food_safety_cleaning_locations;
create policy food_safety_cleaning_locations_update_org on public.food_safety_cleaning_locations
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_locations_delete_org on public.food_safety_cleaning_locations;
create policy food_safety_cleaning_locations_delete_org on public.food_safety_cleaning_locations
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_cleaning_locations to service_role;


create table if not exists public.food_safety_cleaning_tasks (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  location_id     uuid        not null references public.food_safety_cleaning_locations(id) on delete cascade,
  name            text        not null,
  frequency       text        not null check (frequency in ('daily', 'weekly', 'monthly', 'annually')),
  sort_order      integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists food_safety_cleaning_tasks_org_idx
  on public.food_safety_cleaning_tasks (organization_id);

create index if not exists food_safety_cleaning_tasks_location_idx
  on public.food_safety_cleaning_tasks (location_id, sort_order);

alter table public.food_safety_cleaning_tasks enable row level security;

drop policy if exists food_safety_cleaning_tasks_select_org on public.food_safety_cleaning_tasks;
create policy food_safety_cleaning_tasks_select_org on public.food_safety_cleaning_tasks
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_tasks_insert_org on public.food_safety_cleaning_tasks;
create policy food_safety_cleaning_tasks_insert_org on public.food_safety_cleaning_tasks
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_tasks_update_org on public.food_safety_cleaning_tasks;
create policy food_safety_cleaning_tasks_update_org on public.food_safety_cleaning_tasks
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_tasks_delete_org on public.food_safety_cleaning_tasks;
create policy food_safety_cleaning_tasks_delete_org on public.food_safety_cleaning_tasks
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_cleaning_tasks to service_role;
