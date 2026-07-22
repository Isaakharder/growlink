-- Food Safety completed-location reports.
--
-- One row per fully-completed location checklist *cycle* — which may span
-- multiple frequency checklists at once (e.g. a location with both daily and
-- weekly tasks currently due gets one combined report the moment both of
-- those checklists are complete). Created automatically the instant the last
-- outstanding required task for that cycle is checked — see
-- server/src/routes/foodSafety/services/reportGeneration.ts.
--
-- Genuinely decoupled from food_safety_cleaning_checklists/_items (a full
-- snapshot copy, not a live join or FK-only reference): both the parent
-- location and its checklists/items can be edited, and the location can be
-- deleted (cascading away its checklists/items), but a historical report
-- must never change or disappear as a result.
--
-- period_signature is a deterministic "period_type:period_key" list (sorted,
-- pipe-joined) built from every checklist that contributed to this report —
-- e.g. "daily:2026-07-21|weekly:2026-W30". A unique constraint on
-- (location_id, period_signature) is what makes report creation idempotent:
-- two devices finishing different frequency-checklists for the same location
-- at nearly the same moment can both attempt to create the report, but only
-- one insert succeeds — the other is a harmless no-op.

create table if not exists public.food_safety_cleaning_reports (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        not null references public.organizations(id) on delete cascade,
  location_id            uuid        references public.food_safety_cleaning_locations(id) on delete set null,
  location_name_snapshot text        not null,
  location_area_snapshot text        not null,
  period_signature       text        not null,
  task_count             integer     not null default 0,
  completed_at           timestamptz not null,
  completed_by_user_id   uuid        references auth.users(id) on delete set null,
  completed_by_name      text        not null,
  completed_by_initials  text        not null,
  created_at             timestamptz not null default now(),
  constraint food_safety_cleaning_reports_location_period_key
    unique (location_id, period_signature)
);

create index if not exists food_safety_cleaning_reports_org_idx
  on public.food_safety_cleaning_reports (organization_id);

-- Backs "latest 28 reports for this location" — DESC on completed_at means
-- that query is a pure index scan with a LIMIT, no sort step.
create index if not exists food_safety_cleaning_reports_location_completed_idx
  on public.food_safety_cleaning_reports (location_id, completed_at desc);

alter table public.food_safety_cleaning_reports enable row level security;

drop policy if exists food_safety_cleaning_reports_select_org on public.food_safety_cleaning_reports;
create policy food_safety_cleaning_reports_select_org on public.food_safety_cleaning_reports
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_reports_insert_org on public.food_safety_cleaning_reports;
create policy food_safety_cleaning_reports_insert_org on public.food_safety_cleaning_reports
  for insert to authenticated
  with check (public.is_org_member(organization_id));

-- No update/delete grant, and the trigger below blocks it outright even for
-- service_role — this step deliberately ships with no editing/correction
-- capability, so the immutability guarantee is enforced at the DB level.
grant select, insert on table public.food_safety_cleaning_reports to service_role;


create table if not exists public.food_safety_cleaning_report_items (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         uuid        not null references public.organizations(id) on delete cascade,
  report_id               uuid        not null references public.food_safety_cleaning_reports(id) on delete cascade,
  task_name_snapshot      text        not null,
  frequency_snapshot      text        not null check (frequency_snapshot in ('daily', 'weekly', 'monthly', 'annually')),
  response_type_snapshot  text        not null check (response_type_snapshot in ('checkbox', 'number', 'short_text', 'long_text')),
  action_label_snapshot   text,
  response_value          text,
  sort_order              integer     not null default 0,
  checked_at              timestamptz,
  checked_by_user_id      uuid        references auth.users(id) on delete set null,
  checked_by_name         text,
  checked_by_initials     text,
  created_at              timestamptz not null default now()
);

create index if not exists food_safety_cleaning_report_items_org_idx
  on public.food_safety_cleaning_report_items (organization_id);

create index if not exists food_safety_cleaning_report_items_report_idx
  on public.food_safety_cleaning_report_items (report_id, sort_order);

alter table public.food_safety_cleaning_report_items enable row level security;

drop policy if exists food_safety_cleaning_report_items_select_org on public.food_safety_cleaning_report_items;
create policy food_safety_cleaning_report_items_select_org on public.food_safety_cleaning_report_items
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_report_items_insert_org on public.food_safety_cleaning_report_items;
create policy food_safety_cleaning_report_items_insert_org on public.food_safety_cleaning_report_items
  for insert to authenticated
  with check (public.is_org_member(organization_id));

grant select, insert on table public.food_safety_cleaning_report_items to service_role;

-- Immutability guard, mirroring the pattern used for other Food Safety audit
-- trails: unconditionally reject UPDATE/DELETE so a future bug (or a future
-- "corrections" feature added without deliberate intent) can never silently
-- rewrite completed report history.
create or replace function public.food_safety_prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'This row is part of an immutable Food Safety report and cannot be changed.'
    using errcode = '42501';
end;
$$;

create trigger food_safety_cleaning_reports_immutable
  before update or delete on public.food_safety_cleaning_reports
  for each row execute function public.food_safety_prevent_mutation();

create trigger food_safety_cleaning_report_items_immutable
  before update or delete on public.food_safety_cleaning_report_items
  for each row execute function public.food_safety_prevent_mutation();

-- Report generation checks whether every currently-due checklist for a
-- location is complete; this index backs that lookup.
create index if not exists food_safety_cleaning_checklists_org_status_idx
  on public.food_safety_cleaning_checklists (organization_id, status);
