-- Shared employee registry, organization-scoped.
--
-- Intended to become the canonical employee identity model across GrowLink
-- (Food Safety, Training, Maintenance, Quality, Payroll) over time. This
-- migration only creates the table — quality_employees and payroll_employees
-- are NOT migrated or modified here, and no existing route reads from or
-- writes to this table yet.
--
-- user_id is an optional link to auth.users for employees who also have a
-- GrowLink login (e.g. a supervisor); most contractors/shop-floor staff will
-- have no login at all, consistent with the existing payroll_employees /
-- quality_employees pattern of name-only records.

create table if not exists public.employees (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  employee_code   text,
  first_name      text        not null,
  last_name       text        not null,
  display_name    text        not null,
  active          boolean     not null default true,
  user_id         uuid        references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists employees_org_idx
  on public.employees (organization_id);

create index if not exists employees_org_active_idx
  on public.employees (organization_id, active);

-- Partial unique indexes: employee_code and user_id are both optional, but
-- when present must be unique within the organization.
create unique index if not exists employees_org_code_key
  on public.employees (organization_id, employee_code)
  where employee_code is not null;

create unique index if not exists employees_org_user_key
  on public.employees (organization_id, user_id)
  where user_id is not null;

alter table public.employees enable row level security;

drop policy if exists employees_select_org on public.employees;
create policy employees_select_org on public.employees
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists employees_insert_org on public.employees;
create policy employees_insert_org on public.employees
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists employees_update_org on public.employees;
create policy employees_update_org on public.employees
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists employees_delete_org on public.employees;
create policy employees_delete_org on public.employees
  for delete to authenticated
  using (public.is_org_member(organization_id));

-- No anon/authenticated table grant: this table is server-only for now,
-- consistent with CLAUDE.md's baseline convention. The RLS policies above
-- exist as a backstop in case a client-facing grant is ever added later.
grant select, insert, update, delete on table public.employees to service_role;
