-- Calibration module — Task -> Response Fields data model.
--
-- Replaces the previous model, where a top-level pest_calibration_
-- template_fields row was EITHER a directly-answerable field OR a
-- 'repeating_group' container whose children were the real fields — a
-- conflation of "task" and "field" identity that made a plain task with
-- several fields (not repeating) awkward to represent (the prior session's
-- "cap a repeating group at 1 row" was a workaround for exactly this gap).
--
-- New shape: a real pest_calibration_tasks table always holds the
-- name/order/repeating-config; pest_calibration_template_fields always
-- belongs directly to a task (task_id, no more self-referencing
-- parent_field_id, no more 'repeating_group' as a field_type — repeating-
-- ness is now a per-task boolean, not a field type). A non-repeating
-- task's fields are answered once, flat, in pest_calibration_record_
-- answers (now task-stamped so the record detail view can group them back
-- under their task); a repeating task's fields go through pest_calibration_
-- record_repeating_rows/_repeating_answers exactly as before, just keyed
-- by task_id instead of a "group field" id.
--
-- This is a full reset of the templates/fields/records layer, not an
-- ALTER migration: hosted had exactly one real device and one completed
-- record at the time this was written, both created minutes earlier as
-- this module's own verification example — not real user data — so a
-- clean rebuild is safer and far simpler than a data-preserving transform
-- (turning every existing field into a task-with-one-field, remapping
-- every repeating_group into an is_repeating task, and back-filling task
-- snapshots onto the one existing record for no real benefit).
-- pest_calibration_devices is untouched — device identity/frequency/notes/
-- instructions/is_active are unaffected by this change.

-- ============================================================
-- SECTION 1: drop the old templates/fields/records layer
-- ============================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('pest_calibration_complete_record', 'pest_calibration_prevent_mutation')
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

drop table if exists public.pest_calibration_record_repeating_answers cascade;
drop table if exists public.pest_calibration_record_repeating_rows cascade;
drop table if exists public.pest_calibration_record_answers cascade;
drop table if exists public.pest_calibration_records cascade;
drop table if exists public.pest_calibration_template_fields cascade;
drop table if exists public.pest_calibration_templates cascade;

-- ============================================================
-- SECTION 2: pest_calibration_templates (1:1 with device) — unchanged shape
-- ============================================================

create table public.pest_calibration_templates (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null references public.organizations(id) on delete cascade,
  device_id            uuid        not null unique references public.pest_calibration_devices(id) on delete cascade,
  overall_result_mode  text        not null default 'manual' check (overall_result_mode in ('manual', 'auto_numeric_range', 'auto_pass_fail')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index pest_calibration_templates_org_idx on public.pest_calibration_templates (organization_id);

alter table public.pest_calibration_templates enable row level security;

create policy pest_calibration_templates_select_org on public.pest_calibration_templates
  for select to authenticated using (public.is_org_member(organization_id));
create policy pest_calibration_templates_insert_org on public.pest_calibration_templates
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy pest_calibration_templates_update_org on public.pest_calibration_templates
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy pest_calibration_templates_delete_org on public.pest_calibration_templates
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.pest_calibration_templates to service_role;

-- ============================================================
-- SECTION 3: pest_calibration_tasks  ("Tasks" — the employee-facing card)
-- ============================================================

create table public.pest_calibration_tasks (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  template_id     uuid        not null references public.pest_calibration_templates(id) on delete cascade,
  name            text        not null,
  sort_order      integer     not null default 0,
  is_repeating    boolean     not null default false,
  -- Only meaningful when is_repeating; null = unbounded.
  min_rows        integer,
  max_rows        integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index pest_calibration_tasks_template_idx on public.pest_calibration_tasks (template_id, sort_order);

alter table public.pest_calibration_tasks enable row level security;

create policy pest_calibration_tasks_select_org on public.pest_calibration_tasks
  for select to authenticated using (public.is_org_member(organization_id));
create policy pest_calibration_tasks_insert_org on public.pest_calibration_tasks
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy pest_calibration_tasks_update_org on public.pest_calibration_tasks
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy pest_calibration_tasks_delete_org on public.pest_calibration_tasks
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.pest_calibration_tasks to service_role;

-- ============================================================
-- SECTION 4: pest_calibration_template_fields  ("Response Fields")
-- ============================================================

create table public.pest_calibration_template_fields (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null references public.organizations(id) on delete cascade,
  task_id            uuid        not null references public.pest_calibration_tasks(id) on delete cascade,
  field_type         text        not null check (field_type in ('checkbox', 'short_text', 'long_text', 'number', 'pass_fail', 'multiple_choice', 'date')),
  label              text        not null,
  help_text          text,
  is_required        boolean     not null default false,
  placeholder        text,
  unit               text,
  min_value          numeric,
  max_value          numeric,
  decimal_precision  integer,
  -- multiple_choice: selectable options. checkbox: individually-checkable
  -- labels (multi-select). pass_fail: exactly 2 entries [pass label, fail
  -- label], defaulting to ["Pass", "Fail"].
  choice_options     jsonb,
  sort_order         integer     not null default 0,
  -- Reserved for future conditional-required support (e.g. "Corrective
  -- action" required only when a sibling pass_fail field is Fail) — not
  -- read or written by any validation logic yet.
  required_when_field_id uuid    references public.pest_calibration_template_fields(id) on delete set null,
  required_when_equals   jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index pest_calibration_template_fields_task_idx on public.pest_calibration_template_fields (task_id, sort_order);

alter table public.pest_calibration_template_fields enable row level security;

create policy pest_calibration_template_fields_select_org on public.pest_calibration_template_fields
  for select to authenticated using (public.is_org_member(organization_id));
create policy pest_calibration_template_fields_insert_org on public.pest_calibration_template_fields
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy pest_calibration_template_fields_update_org on public.pest_calibration_template_fields
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy pest_calibration_template_fields_delete_org on public.pest_calibration_template_fields
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.pest_calibration_template_fields to service_role;

-- Manual-mode overall-result field pointer. Only meaningful when
-- overall_result_mode = 'manual'; must reference a checkbox/pass_fail
-- field belonging to a non-repeating task (enforced in the API layer —
-- no single answer to point at across N rows of a repeating task).
alter table public.pest_calibration_templates
  add column overall_result_field_id uuid references public.pest_calibration_template_fields(id) on delete set null;

-- ============================================================
-- SECTION 5: pest_calibration_records (immutable) — unchanged shape
-- ============================================================

create table public.pest_calibration_records (
  id                                     uuid        primary key default gen_random_uuid(),
  organization_id                        uuid        not null references public.organizations(id) on delete cascade,
  device_id                              uuid        references public.pest_calibration_devices(id) on delete set null,
  template_id                            uuid        references public.pest_calibration_templates(id) on delete set null,
  device_name_snapshot                   text        not null,
  device_identification_number_snapshot  text,
  device_area_snapshot                   text,
  device_frequency_snapshot              jsonb       not null,
  instructions_snapshot                  text,
  overall_result_mode_snapshot           text        not null,
  calculated_result                      text        not null check (calculated_result in ('pass', 'fail')),
  recorded_result                        text        not null check (recorded_result in ('pass', 'fail')),
  result_discrepancy                     boolean     not null default false,
  completed_by_user_id                   uuid        references auth.users(id) on delete set null,
  completed_by_name                      text        not null,
  completed_at                           timestamptz not null,
  next_due_at                            timestamptz,
  completion_request_id                  uuid        not null,
  created_at                             timestamptz not null default now(),
  constraint pest_calibration_records_completion_request_id_key
    unique (organization_id, completion_request_id)
);

create index pest_calibration_records_org_completed_idx
  on public.pest_calibration_records (organization_id, completed_at desc, id desc);
create index pest_calibration_records_org_device_completed_idx
  on public.pest_calibration_records (organization_id, device_id, completed_at desc, id desc);
create index pest_calibration_records_org_completed_by_idx
  on public.pest_calibration_records (organization_id, completed_by_user_id);

alter table public.pest_calibration_records enable row level security;

create policy pest_calibration_records_select_org on public.pest_calibration_records
  for select to authenticated using (public.is_org_member(organization_id));
create policy pest_calibration_records_insert_org on public.pest_calibration_records
  for insert to authenticated with check (public.is_org_member(organization_id));

-- No update/delete grant or policy — immutability trigger below is the
-- real guarantee, this is belt-and-suspenders.
grant select, insert on table public.pest_calibration_records to service_role;

-- ============================================================
-- SECTION 6: pest_calibration_record_answers (immutable)
-- Non-repeating tasks' fields are answered flat, here — task_id/
-- task_name_snapshot/task_sort_order let the record detail view group
-- them back under their task.
-- ============================================================

create table public.pest_calibration_record_answers (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null references public.organizations(id) on delete cascade,
  record_id                   uuid        not null references public.pest_calibration_records(id) on delete cascade,
  task_id                     uuid        references public.pest_calibration_tasks(id) on delete set null,
  task_name_snapshot          text        not null,
  task_sort_order             integer     not null default 0,
  template_field_id           uuid        references public.pest_calibration_template_fields(id) on delete set null,
  field_label_snapshot        text        not null,
  field_type_snapshot         text        not null,
  help_text_snapshot          text,
  placeholder_snapshot        text,
  unit_snapshot               text,
  min_value_snapshot          numeric,
  max_value_snapshot          numeric,
  decimal_precision_snapshot  integer,
  choice_options_snapshot     jsonb,
  is_required_snapshot        boolean     not null default false,
  sort_order                  integer     not null default 0,
  value_text                  text,
  value_number                numeric,
  value_boolean               boolean,
  value_date                  date,
  value_choices               jsonb,
  is_within_range             boolean,
  created_at                  timestamptz not null default now()
);

create index pest_calibration_record_answers_record_idx
  on public.pest_calibration_record_answers (record_id, task_sort_order, sort_order);

alter table public.pest_calibration_record_answers enable row level security;

create policy pest_calibration_record_answers_select_org on public.pest_calibration_record_answers
  for select to authenticated using (public.is_org_member(organization_id));
create policy pest_calibration_record_answers_insert_org on public.pest_calibration_record_answers
  for insert to authenticated with check (public.is_org_member(organization_id));

grant select, insert on table public.pest_calibration_record_answers to service_role;

-- ============================================================
-- SECTION 7: pest_calibration_record_repeating_rows (immutable)
-- One row per "Add Row" click on a repeating task.
-- ============================================================

create table public.pest_calibration_record_repeating_rows (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null references public.organizations(id) on delete cascade,
  record_id            uuid        not null references public.pest_calibration_records(id) on delete cascade,
  task_id              uuid        references public.pest_calibration_tasks(id) on delete set null,
  task_name_snapshot   text        not null,
  task_sort_order      integer     not null default 0,
  row_index            integer     not null,
  created_at           timestamptz not null default now()
);

create index pest_calibration_record_repeating_rows_record_idx
  on public.pest_calibration_record_repeating_rows (record_id, task_sort_order, row_index);

alter table public.pest_calibration_record_repeating_rows enable row level security;

create policy pest_calibration_record_repeating_rows_select_org on public.pest_calibration_record_repeating_rows
  for select to authenticated using (public.is_org_member(organization_id));
create policy pest_calibration_record_repeating_rows_insert_org on public.pest_calibration_record_repeating_rows
  for insert to authenticated with check (public.is_org_member(organization_id));

grant select, insert on table public.pest_calibration_record_repeating_rows to service_role;

-- ============================================================
-- SECTION 8: pest_calibration_record_repeating_answers (immutable)
-- ============================================================

create table public.pest_calibration_record_repeating_answers (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null references public.organizations(id) on delete cascade,
  repeating_row_id            uuid        not null references public.pest_calibration_record_repeating_rows(id) on delete cascade,
  template_field_id           uuid        references public.pest_calibration_template_fields(id) on delete set null,
  field_label_snapshot        text        not null,
  field_type_snapshot         text        not null,
  help_text_snapshot          text,
  placeholder_snapshot        text,
  unit_snapshot               text,
  min_value_snapshot          numeric,
  max_value_snapshot          numeric,
  decimal_precision_snapshot  integer,
  choice_options_snapshot     jsonb,
  is_required_snapshot        boolean     not null default false,
  sort_order                  integer     not null default 0,
  value_text                  text,
  value_number                numeric,
  value_boolean               boolean,
  value_date                  date,
  value_choices               jsonb,
  is_within_range             boolean,
  created_at                  timestamptz not null default now()
);

create index pest_calibration_record_repeating_answers_row_idx
  on public.pest_calibration_record_repeating_answers (repeating_row_id, sort_order);

alter table public.pest_calibration_record_repeating_answers enable row level security;

create policy pest_calibration_record_repeating_answers_select_org on public.pest_calibration_record_repeating_answers
  for select to authenticated using (public.is_org_member(organization_id));
create policy pest_calibration_record_repeating_answers_insert_org on public.pest_calibration_record_repeating_answers
  for insert to authenticated with check (public.is_org_member(organization_id));

grant select, insert on table public.pest_calibration_record_repeating_answers to service_role;

-- ============================================================
-- SECTION 9: immutability trigger
-- ============================================================

create or replace function public.pest_calibration_prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'This row is part of an immutable calibration record and cannot be changed.'
    using errcode = '42501';
end;
$$;

create trigger pest_calibration_records_immutable
  before update or delete on public.pest_calibration_records
  for each row execute function public.pest_calibration_prevent_mutation();

create trigger pest_calibration_record_answers_immutable
  before update or delete on public.pest_calibration_record_answers
  for each row execute function public.pest_calibration_prevent_mutation();

create trigger pest_calibration_record_repeating_rows_immutable
  before update or delete on public.pest_calibration_record_repeating_rows
  for each row execute function public.pest_calibration_prevent_mutation();

create trigger pest_calibration_record_repeating_answers_immutable
  before update or delete on public.pest_calibration_record_repeating_answers
  for each row execute function public.pest_calibration_prevent_mutation();
