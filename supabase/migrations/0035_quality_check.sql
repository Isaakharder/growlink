-- Quality Check module: employees, metrics, thresholds, check records

create table if not exists public.quality_employees (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name            text not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table if not exists public.quality_metrics (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name            text not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- One row per org. Use upsert on PUT /api/quality/threshold.
create table if not exists public.quality_thresholds (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  allowed_issues  integer not null default 10,
  stems_checked   integer not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.quality_checks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id     uuid not null references public.quality_employees(id),
  phase_id        uuid,
  phase_name      text not null,
  row_id          uuid,
  row_number      integer not null,
  stems_checked   integer not null,
  metric_counts   jsonb not null default '{}',
  total_issues    integer not null default 0,
  notes           text,
  checked_at      timestamptz not null default now(),
  created_by      uuid,
  created_at      timestamptz not null default now()
);

-- Indexes
create index if not exists quality_employees_org_idx   on public.quality_employees   (organization_id);
create index if not exists quality_metrics_org_idx     on public.quality_metrics     (organization_id);
create index if not exists quality_thresholds_org_idx  on public.quality_thresholds  (organization_id);
create index if not exists quality_checks_org_idx      on public.quality_checks      (organization_id);
create index if not exists quality_checks_employee_idx on public.quality_checks      (employee_id);
create index if not exists quality_checks_checked_at   on public.quality_checks      (checked_at desc);

-- RLS
alter table public.quality_employees  enable row level security;
alter table public.quality_metrics    enable row level security;
alter table public.quality_thresholds enable row level security;
alter table public.quality_checks     enable row level security;

-- quality_employees
create policy quality_employees_select on public.quality_employees
  for select to authenticated using (public.is_org_member(organization_id));
create policy quality_employees_insert on public.quality_employees
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy quality_employees_update on public.quality_employees
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- quality_metrics
create policy quality_metrics_select on public.quality_metrics
  for select to authenticated using (public.is_org_member(organization_id));
create policy quality_metrics_insert on public.quality_metrics
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy quality_metrics_update on public.quality_metrics
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- quality_thresholds
create policy quality_thresholds_select on public.quality_thresholds
  for select to authenticated using (public.is_org_member(organization_id));
create policy quality_thresholds_insert on public.quality_thresholds
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy quality_thresholds_update on public.quality_thresholds
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- quality_checks
create policy quality_checks_select on public.quality_checks
  for select to authenticated using (public.is_org_member(organization_id));
create policy quality_checks_insert on public.quality_checks
  for insert to authenticated with check (public.is_org_member(organization_id));

-- Grants
grant all on table public.quality_employees  to anon, authenticated, service_role;
grant all on table public.quality_metrics    to anon, authenticated, service_role;
grant all on table public.quality_thresholds to anon, authenticated, service_role;
grant all on table public.quality_checks     to anon, authenticated, service_role;
