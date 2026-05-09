create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from public.organizations) then
    insert into public.organizations (id, name)
    values (gen_random_uuid(), 'Default Organization');
  end if;
end $$;

alter table if exists public.varieties
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.yield_entries
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.color_case_entries
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.yield_sizes
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.greenhouse_rows
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.daily_yield_samples
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.organization_integrations
  add column if not exists organization_id uuid references public.organizations(id);

alter table if exists public.greenhouse_phases
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.irrigation_setups
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.irrigation_logs
  add column if not exists organization_id uuid references public.organizations(id);

alter table if exists public.greenhouse_groups
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.greenhouse_row_sections
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.greenhouse_variety_assignments
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.irrigation_groups
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.irrigation_feed_valves
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.irrigation_drain_buckets
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.mobile_irrigation_logs
  add column if not exists organization_id uuid references public.organizations(id);
alter table if exists public.daily_yield_bin_settings
  add column if not exists organization_id uuid references public.organizations(id);

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.varieties v
set organization_id = d.id
from default_org d
where v.organization_id is null;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.yield_sizes ys
set organization_id = d.id
from default_org d
where ys.organization_id is null;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.color_case_entries c
set organization_id = d.id
from default_org d
where c.organization_id is null;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.greenhouse_groups g
set organization_id = d.id
from default_org d
where g.organization_id is null;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.irrigation_groups g
set organization_id = d.id
from default_org d
where g.organization_id is null;

update public.yield_entries ye
set organization_id = v.organization_id
from public.varieties v
where ye.organization_id is null
  and ye.variety_id = v.id;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.yield_entries ye
set organization_id = d.id
from default_org d
where ye.organization_id is null;

update public.greenhouse_row_sections s
set organization_id = g.organization_id
from public.greenhouse_groups g
where s.organization_id is null
  and s.group_id = g.id;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.greenhouse_row_sections s
set organization_id = d.id
from default_org d
where s.organization_id is null;

update public.greenhouse_rows r
set organization_id = g.organization_id
from public.greenhouse_groups g
where r.organization_id is null
  and r.group_id = g.id;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.greenhouse_rows r
set organization_id = d.id
from default_org d
where r.organization_id is null;

update public.greenhouse_variety_assignments a
set organization_id = g.organization_id
from public.greenhouse_groups g
where a.organization_id is null
  and a.group_id = g.id;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.greenhouse_variety_assignments a
set organization_id = d.id
from default_org d
where a.organization_id is null;

update public.irrigation_feed_valves f
set organization_id = g.organization_id
from public.irrigation_groups g
where f.organization_id is null
  and f.group_id = g.id;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.irrigation_feed_valves f
set organization_id = d.id
from default_org d
where f.organization_id is null;

update public.irrigation_drain_buckets b
set organization_id = g.organization_id
from public.irrigation_groups g
where b.organization_id is null
  and b.group_id = g.id;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.irrigation_drain_buckets b
set organization_id = d.id
from default_org d
where b.organization_id is null;

update public.mobile_irrigation_logs l
set organization_id = g.organization_id
from public.irrigation_groups g
where l.organization_id is null
  and l.group_id = g.id;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.mobile_irrigation_logs l
set organization_id = d.id
from default_org d
where l.organization_id is null;

update public.daily_yield_samples s
set organization_id = v.organization_id
from public.varieties v
where s.organization_id is null
  and s.variety_id = v.id;

update public.daily_yield_samples s
set organization_id = r.organization_id
from public.greenhouse_rows r
where s.organization_id is null
  and s.row_id = r.id;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.daily_yield_samples s
set organization_id = d.id
from default_org d
where s.organization_id is null;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.daily_yield_bin_settings s
set organization_id = d.id
from default_org d
where s.organization_id is null;

with default_org as (
  select id from public.organizations order by created_at asc, id asc limit 1
)
update public.organization_integrations oi
set organization_id = d.id
from default_org d
where oi.organization_id is null;

alter table if exists public.varieties alter column organization_id set not null;
alter table if exists public.yield_entries alter column organization_id set not null;
alter table if exists public.color_case_entries alter column organization_id set not null;
alter table if exists public.yield_sizes alter column organization_id set not null;
alter table if exists public.greenhouse_rows alter column organization_id set not null;
alter table if exists public.daily_yield_samples alter column organization_id set not null;
alter table if exists public.organization_integrations alter column organization_id set not null;

alter table if exists public.greenhouse_groups alter column organization_id set not null;
alter table if exists public.greenhouse_row_sections alter column organization_id set not null;
alter table if exists public.greenhouse_variety_assignments alter column organization_id set not null;
alter table if exists public.irrigation_groups alter column organization_id set not null;
alter table if exists public.irrigation_feed_valves alter column organization_id set not null;
alter table if exists public.irrigation_drain_buckets alter column organization_id set not null;
alter table if exists public.mobile_irrigation_logs alter column organization_id set not null;
alter table if exists public.daily_yield_bin_settings alter column organization_id set not null;

create index if not exists varieties_organization_id_idx on public.varieties (organization_id);
create index if not exists yield_entries_organization_id_idx on public.yield_entries (organization_id);
create index if not exists color_case_entries_organization_id_idx on public.color_case_entries (organization_id);
create index if not exists yield_sizes_organization_id_idx on public.yield_sizes (organization_id);
create index if not exists greenhouse_rows_organization_id_idx on public.greenhouse_rows (organization_id);
create index if not exists daily_yield_samples_organization_id_idx on public.daily_yield_samples (organization_id);
create index if not exists organization_integrations_organization_id_idx on public.organization_integrations (organization_id);

create index if not exists greenhouse_groups_organization_id_idx on public.greenhouse_groups (organization_id);
create index if not exists greenhouse_row_sections_organization_id_idx on public.greenhouse_row_sections (organization_id);
create index if not exists greenhouse_assignments_organization_id_idx on public.greenhouse_variety_assignments (organization_id);
create index if not exists irrigation_groups_organization_id_idx on public.irrigation_groups (organization_id);
create index if not exists irrigation_feed_valves_organization_id_idx on public.irrigation_feed_valves (organization_id);
create index if not exists irrigation_drain_buckets_organization_id_idx on public.irrigation_drain_buckets (organization_id);
create index if not exists mobile_irrigation_logs_organization_id_idx on public.mobile_irrigation_logs (organization_id);
create index if not exists daily_yield_bin_settings_organization_id_idx on public.daily_yield_bin_settings (organization_id);

do $$
declare
  default_org_id uuid;
begin
  select id into default_org_id
  from public.organizations
  order by created_at asc, id asc
  limit 1;

  if to_regclass('public.greenhouse_phases') is not null then
    execute format(
      'update public.greenhouse_phases set organization_id = %L where organization_id is null',
      default_org_id
    );
    execute 'alter table public.greenhouse_phases alter column organization_id set not null';
    execute 'create index if not exists greenhouse_phases_organization_id_idx on public.greenhouse_phases (organization_id)';
  end if;

  if to_regclass('public.irrigation_setups') is not null then
    execute format(
      'update public.irrigation_setups set organization_id = %L where organization_id is null',
      default_org_id
    );
    execute 'alter table public.irrigation_setups alter column organization_id set not null';
    execute 'create index if not exists irrigation_setups_organization_id_idx on public.irrigation_setups (organization_id)';
  end if;

  if to_regclass('public.irrigation_logs') is not null then
    execute format(
      'update public.irrigation_logs set organization_id = %L where organization_id is null',
      default_org_id
    );
    execute 'alter table public.irrigation_logs alter column organization_id set not null';
    execute 'create index if not exists irrigation_logs_organization_id_idx on public.irrigation_logs (organization_id)';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'mobile_irrigation_logs_log_date_group_key_key'
      and conrelid = 'public.mobile_irrigation_logs'::regclass
  ) then
    alter table public.mobile_irrigation_logs
      drop constraint mobile_irrigation_logs_log_date_group_key_key;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'mobile_irrigation_logs_org_log_date_group_key_key'
      and conrelid = 'public.mobile_irrigation_logs'::regclass
  ) then
    alter table public.mobile_irrigation_logs
      add constraint mobile_irrigation_logs_org_log_date_group_key_key
      unique (organization_id, log_date, group_key);
  end if;
end $$;

do $$
begin
  delete from public.color_case_entries a
  using public.color_case_entries b
  where a.organization_id = b.organization_id
    and a.color = b.color
    and a.year = b.year
    and a.week = b.week
    and a.ctid < b.ctid;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'color_case_entries_org_color_year_week_key'
      and conrelid = 'public.color_case_entries'::regclass
  ) then
    alter table public.color_case_entries
      add constraint color_case_entries_org_color_year_week_key
      unique (organization_id, color, year, week);
  end if;
end $$;