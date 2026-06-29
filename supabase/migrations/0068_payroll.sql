-- Payroll module: contractor hour tracking
-- Stores employees, raw time logs, and per-org rounding/deduction settings.
-- Original timestamps are always preserved; rounding is computed on read.

-- ── payroll_employees ─────────────────────────────────────────────────────────

create table if not exists public.payroll_employees (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  name             text        not null,
  active           boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index payroll_employees_org_idx
  on public.payroll_employees (organization_id);

alter table public.payroll_employees enable row level security;

drop policy if exists payroll_employees_select on public.payroll_employees;
create policy payroll_employees_select on public.payroll_employees
  for select to public using (true);

drop policy if exists payroll_employees_insert on public.payroll_employees;
create policy payroll_employees_insert on public.payroll_employees
  for insert to public with check (true);

drop policy if exists payroll_employees_update on public.payroll_employees;
create policy payroll_employees_update on public.payroll_employees
  for update to public using (true) with check (true);

drop policy if exists payroll_employees_delete on public.payroll_employees;
create policy payroll_employees_delete on public.payroll_employees
  for delete to public using (true);

grant select, insert, update, delete on table public.payroll_employees to service_role;

-- ── payroll_time_logs ─────────────────────────────────────────────────────────
-- clocked_out_at is null while the shift is active.
-- Rounding and break deductions are applied at query time from payroll_settings.

create table if not exists public.payroll_time_logs (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  employee_id      uuid        not null references public.payroll_employees(id) on delete cascade,
  clocked_in_at    timestamptz not null,
  clocked_out_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index payroll_time_logs_org_idx
  on public.payroll_time_logs (organization_id);

create index payroll_time_logs_employee_idx
  on public.payroll_time_logs (organization_id, employee_id);

-- Partial index speeds up the "is this employee currently clocked in?" check.
create index payroll_time_logs_active_idx
  on public.payroll_time_logs (organization_id, employee_id)
  where clocked_out_at is null;

alter table public.payroll_time_logs enable row level security;

drop policy if exists payroll_time_logs_select on public.payroll_time_logs;
create policy payroll_time_logs_select on public.payroll_time_logs
  for select to public using (true);

drop policy if exists payroll_time_logs_insert on public.payroll_time_logs;
create policy payroll_time_logs_insert on public.payroll_time_logs
  for insert to public with check (true);

drop policy if exists payroll_time_logs_update on public.payroll_time_logs;
create policy payroll_time_logs_update on public.payroll_time_logs
  for update to public using (true) with check (true);

drop policy if exists payroll_time_logs_delete on public.payroll_time_logs;
create policy payroll_time_logs_delete on public.payroll_time_logs
  for delete to public using (true);

grant select, insert, update, delete on table public.payroll_time_logs to service_role;

-- ── payroll_settings ──────────────────────────────────────────────────────────
-- One row per organization, created on first save.
-- work_day_start is HH:MM in the org's local time (e.g. "07:00").
-- rounding_interval_minutes: 5, 10, 15, etc.
-- break_deduction_minutes: subtracted from every completed shift's net hours.

create table if not exists public.payroll_settings (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null unique,
  work_day_start              text        not null default '07:00'
                                          check (work_day_start ~ '^\d{2}:\d{2}$'),
  rounding_interval_minutes   integer     not null default 15
                                          check (rounding_interval_minutes > 0),
  break_deduction_minutes     integer     not null default 0
                                          check (break_deduction_minutes >= 0),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

alter table public.payroll_settings enable row level security;

drop policy if exists payroll_settings_select on public.payroll_settings;
create policy payroll_settings_select on public.payroll_settings
  for select to public using (true);

drop policy if exists payroll_settings_insert on public.payroll_settings;
create policy payroll_settings_insert on public.payroll_settings
  for insert to public with check (true);

drop policy if exists payroll_settings_update on public.payroll_settings;
create policy payroll_settings_update on public.payroll_settings
  for update to public using (true) with check (true);

drop policy if exists payroll_settings_delete on public.payroll_settings;
create policy payroll_settings_delete on public.payroll_settings
  for delete to public using (true);

grant select, insert, update, delete on table public.payroll_settings to service_role;
