-- Pest Control device Calibration module — schema.
--
-- Not related to the pre-existing public.pest_sprayer_calibrations table
-- (migration 0039), which stores mutable PSI/nozzle-flow settings used for
-- spray-rate math. This feature is a different, general-purpose concept:
-- an admin builds a reusable calibration form (from configurable fields,
-- including repeating groups) for any piece of equipment — scales,
-- sprayers, meters, thermometers, injectors, etc. — and employees complete
-- immutable calibration records against that form.
--
-- Deliberately mirrors Food Safety's Location editor (food_safety_cleaning_
-- locations/_tasks, migrations 0084+): a device is the "location" analog
-- (name, area, frequency, notes, instructions) and its calibration fields
-- are the "tasks" analog. Two layers, same shape as Food Safety's
-- checklist precedent:
--   1. Mutable admin config: pest_calibration_devices, _templates,
--      _template_fields. Standard authenticated CRUD RLS, scoped by
--      is_org_member(organization_id) — same as
--      food_safety_cleaning_locations/_tasks. Real enforcement of who may
--      write happens via requirePermission("calibration:edit") in Express;
--      RLS here is the org-isolation backstop, not the primary gate.
--   2. Immutable records: pest_calibration_records, _record_answers,
--      _record_repeating_rows, _record_repeating_answers. Every
--      display-relevant field is a literal *_snapshot column, never a live
--      join, so editing a device/template/instructions later can never
--      alter history. service_role-only writes (select+insert, no
--      update/delete grant) plus a BEFORE UPDATE OR DELETE trigger
--      (pest_calibration_prevent_mutation) as belt-and-suspenders,
--      mirroring food_safety_cleaning_reports/_report_items exactly.
--
-- Unlike Food Safety's mobile_instructions (never snapshotted into a
-- report), pest_calibration_records.instructions_snapshot IS captured on
-- every completed record — a deliberate departure, since knowing exactly
-- what procedure was in force at calibration time carries more audit
-- weight for equipment calibration than for a cleaning checklist.
--
-- Deletion of a completed record is deliberately NOT implemented here.
-- Food Safety's audited-deletion pattern (food_safety_delete_report,
-- migration 0102) is a safe, directly reusable template for a future pass,
-- but building it out (audit table + SECURITY DEFINER RPC + UI) is
-- comparable in size to the rest of this feature and isn't needed yet.

-- ============================================================
-- SECTION 1: pest_calibration_devices
-- ============================================================

create table if not exists public.pest_calibration_devices (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        not null references public.organizations(id) on delete cascade,
  name                   text        not null,
  -- Free text location grouping, matching food_safety_cleaning_locations.area
  -- exactly (name/semantics) rather than a device "category" enum or field —
  -- equipment type is conveyed by the device name itself (e.g. "Packing
  -- Scale 1"), same as Food Safety locations have no equipment-type field.
  area                   text,
  identification_number  text,
  frequency_type         text        not null check (frequency_type in ('daily', 'weekly', 'monthly', 'quarterly', 'annually', 'on_demand', 'custom')),
  custom_interval_value  integer     check (custom_interval_value is null or custom_interval_value > 0),
  custom_interval_unit   text        check (custom_interval_unit in ('days', 'weeks', 'months')),
  -- Admin-internal notes — mirrors food_safety_cleaning_locations.notes.
  -- Never shown to employees, never snapshotted into a completed record.
  notes                  text,
  -- Worker-facing instructions — mirrors food_safety_cleaning_locations.
  -- mobile_instructions. Shown when an employee starts a calibration, and
  -- (unlike Food Safety's mobile_instructions) also snapshotted into every
  -- completed record — see header comment.
  instructions           text,
  is_active              boolean     not null default true,
  -- Denormalized for fast list-view sorting/filtering without a join or
  -- subquery against pest_calibration_records on every page load.
  last_completed_at      timestamptz,
  next_due_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint pest_calibration_devices_custom_interval_check
    check (
      (frequency_type = 'custom' and custom_interval_value is not null and custom_interval_unit is not null)
      or (frequency_type <> 'custom' and custom_interval_value is null and custom_interval_unit is null)
    )
);

create index if not exists pest_calibration_devices_org_idx
  on public.pest_calibration_devices (organization_id);

create index if not exists pest_calibration_devices_org_active_idx
  on public.pest_calibration_devices (organization_id, is_active);

create index if not exists pest_calibration_devices_org_next_due_idx
  on public.pest_calibration_devices (organization_id, next_due_at);

alter table public.pest_calibration_devices enable row level security;

drop policy if exists pest_calibration_devices_select_org on public.pest_calibration_devices;
create policy pest_calibration_devices_select_org on public.pest_calibration_devices
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists pest_calibration_devices_insert_org on public.pest_calibration_devices;
create policy pest_calibration_devices_insert_org on public.pest_calibration_devices
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists pest_calibration_devices_update_org on public.pest_calibration_devices;
create policy pest_calibration_devices_update_org on public.pest_calibration_devices
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists pest_calibration_devices_delete_org on public.pest_calibration_devices;
create policy pest_calibration_devices_delete_org on public.pest_calibration_devices
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.pest_calibration_devices to service_role;

-- ============================================================
-- SECTION 2: pest_calibration_templates (1:1 with device)
-- ============================================================
-- 1:1, not a shared many-to-many template — "reusable calibration form"
-- reads as "the admin builds the form once for this device," matching
-- both worked examples (Packing Scale 1, Sprayer 1), each bespoke to one
-- physical device. overall_result_field_id is added via ALTER TABLE at
-- the end of this file, once pest_calibration_template_fields exists.

create table if not exists public.pest_calibration_templates (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null references public.organizations(id) on delete cascade,
  device_id            uuid        not null unique references public.pest_calibration_devices(id) on delete cascade,
  overall_result_mode  text        not null default 'manual' check (overall_result_mode in ('manual', 'auto_numeric_range', 'auto_pass_fail')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists pest_calibration_templates_org_idx
  on public.pest_calibration_templates (organization_id);

alter table public.pest_calibration_templates enable row level security;

drop policy if exists pest_calibration_templates_select_org on public.pest_calibration_templates;
create policy pest_calibration_templates_select_org on public.pest_calibration_templates
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists pest_calibration_templates_insert_org on public.pest_calibration_templates;
create policy pest_calibration_templates_insert_org on public.pest_calibration_templates
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists pest_calibration_templates_update_org on public.pest_calibration_templates;
create policy pest_calibration_templates_update_org on public.pest_calibration_templates
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists pest_calibration_templates_delete_org on public.pest_calibration_templates;
create policy pest_calibration_templates_delete_org on public.pest_calibration_templates
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.pest_calibration_templates to service_role;

-- ============================================================
-- SECTION 3: pest_calibration_template_fields  ("Tasks")
-- ============================================================

create table if not exists public.pest_calibration_template_fields (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null references public.organizations(id) on delete cascade,
  template_id        uuid        not null references public.pest_calibration_templates(id) on delete cascade,
  field_type         text        not null check (field_type in ('checkbox', 'short_text', 'long_text', 'number', 'pass_fail', 'multiple_choice', 'date', 'repeating_group')),
  label              text        not null,
  help_text          text,
  is_required        boolean     not null default false,
  -- short_text/long_text/number/date only: a UI input hint, not an answer.
  placeholder        text,
  unit               text,
  min_value          numeric,
  max_value          numeric,
  decimal_precision  integer,
  -- Reused across three field_types with different semantics:
  --   multiple_choice: the selectable options (single choice recorded as value_text)
  --   checkbox:        the individually-checkable labels (multi-select recorded
  --                     as value_choices — see record_answers below)
  --   pass_fail:       exactly 2 entries, [pass label, fail label], defaulting
  --                     to ["Pass", "Fail"] — the underlying stored value stays
  --                     a plain boolean, only the displayed labels are custom
  choice_options     jsonb,
  -- repeating_group only; null = unbounded. Meaningless on any other field_type.
  min_rows           integer,
  max_rows           integer,
  sort_order         integer     not null default 0,
  -- Set on a repeating_group's child fields. Only one level of nesting is
  -- supported (a repeating_group may not contain another repeating_group)
  -- — enforced in the API layer, not here, since a DB CHECK constraint
  -- can't easily do cross-row type validation without a trigger.
  parent_field_id    uuid        references public.pest_calibration_template_fields(id) on delete cascade,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists pest_calibration_template_fields_template_idx
  on public.pest_calibration_template_fields (template_id, sort_order);

create index if not exists pest_calibration_template_fields_parent_idx
  on public.pest_calibration_template_fields (parent_field_id);

alter table public.pest_calibration_template_fields enable row level security;

drop policy if exists pest_calibration_template_fields_select_org on public.pest_calibration_template_fields;
create policy pest_calibration_template_fields_select_org on public.pest_calibration_template_fields
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists pest_calibration_template_fields_insert_org on public.pest_calibration_template_fields;
create policy pest_calibration_template_fields_insert_org on public.pest_calibration_template_fields
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists pest_calibration_template_fields_update_org on public.pest_calibration_template_fields;
create policy pest_calibration_template_fields_update_org on public.pest_calibration_template_fields
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists pest_calibration_template_fields_delete_org on public.pest_calibration_template_fields;
create policy pest_calibration_template_fields_delete_org on public.pest_calibration_template_fields
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.pest_calibration_template_fields to service_role;

-- Now that pest_calibration_template_fields exists, add the manual-mode
-- overall-result field pointer. Only meaningful when overall_result_mode =
-- 'manual'; must reference a field of type 'checkbox' or 'pass_fail'
-- (enforced in the API layer).
alter table public.pest_calibration_templates
  add column if not exists overall_result_field_id uuid references public.pest_calibration_template_fields(id) on delete set null;

-- ============================================================
-- SECTION 4: pest_calibration_records (immutable)
-- ============================================================

create table if not exists public.pest_calibration_records (
  id                                     uuid        primary key default gen_random_uuid(),
  organization_id                        uuid        not null references public.organizations(id) on delete cascade,
  device_id                              uuid        references public.pest_calibration_devices(id) on delete set null,
  template_id                            uuid        references public.pest_calibration_templates(id) on delete set null,
  device_name_snapshot                   text        not null,
  device_identification_number_snapshot  text,
  device_area_snapshot                   text,
  device_frequency_snapshot              jsonb       not null,
  -- Plain text, matching pest_calibration_devices.instructions. See header
  -- comment: unlike Food Safety's mobile_instructions, this IS snapshotted.
  instructions_snapshot                  text,
  overall_result_mode_snapshot           text        not null,
  calculated_result                      text        not null check (calculated_result in ('pass', 'fail')),
  recorded_result                        text        not null check (recorded_result in ('pass', 'fail')),
  result_discrepancy                     boolean     not null default false,
  completed_by_user_id                   uuid        references auth.users(id) on delete set null,
  completed_by_name                      text        not null,
  completed_at                           timestamptz not null,
  next_due_at                            timestamptz,
  -- Client-generated (crypto.randomUUID()) once per completion attempt and
  -- resent unchanged on any retry (network timeout, or a double-tap before
  -- the submit button disables) of that SAME attempt. The unique constraint
  -- below is what pest_calibration_complete_record's ON CONFLICT DO NOTHING
  -- relies on to make a retry a safe no-op instead of a duplicate record —
  -- see migration 0104. Required (not null): every completion must go
  -- through the idempotent path, no exceptions.
  completion_request_id                  uuid        not null,
  created_at                             timestamptz not null default now(),
  constraint pest_calibration_records_completion_request_id_key
    unique (organization_id, completion_request_id)
);

create index if not exists pest_calibration_records_org_completed_idx
  on public.pest_calibration_records (organization_id, completed_at desc, id desc);

create index if not exists pest_calibration_records_org_device_completed_idx
  on public.pest_calibration_records (organization_id, device_id, completed_at desc, id desc);

create index if not exists pest_calibration_records_org_completed_by_idx
  on public.pest_calibration_records (organization_id, completed_by_user_id);

alter table public.pest_calibration_records enable row level security;

drop policy if exists pest_calibration_records_select_org on public.pest_calibration_records;
create policy pest_calibration_records_select_org on public.pest_calibration_records
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists pest_calibration_records_insert_org on public.pest_calibration_records;
create policy pest_calibration_records_insert_org on public.pest_calibration_records
  for insert to authenticated
  with check (public.is_org_member(organization_id));

-- No update/delete grant or policy — immutability trigger below is the
-- real guarantee, this is belt-and-suspenders.
grant select, insert on table public.pest_calibration_records to service_role;

-- ============================================================
-- SECTION 5: pest_calibration_record_answers (immutable)
-- ============================================================

create table if not exists public.pest_calibration_record_answers (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null references public.organizations(id) on delete cascade,
  record_id                   uuid        not null references public.pest_calibration_records(id) on delete cascade,
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
  -- checkbox answers only: which of choice_options_snapshot were checked
  -- (array of label strings, a subset of choice_options_snapshot). Null for
  -- every other field_type.
  value_choices               jsonb,
  -- Computed at save time for required number fields with a configured
  -- range. Null when not applicable (not a number field, or no range set).
  is_within_range             boolean,
  created_at                  timestamptz not null default now()
);

create index if not exists pest_calibration_record_answers_record_idx
  on public.pest_calibration_record_answers (record_id, sort_order);

alter table public.pest_calibration_record_answers enable row level security;

drop policy if exists pest_calibration_record_answers_select_org on public.pest_calibration_record_answers;
create policy pest_calibration_record_answers_select_org on public.pest_calibration_record_answers
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists pest_calibration_record_answers_insert_org on public.pest_calibration_record_answers;
create policy pest_calibration_record_answers_insert_org on public.pest_calibration_record_answers
  for insert to authenticated
  with check (public.is_org_member(organization_id));

grant select, insert on table public.pest_calibration_record_answers to service_role;

-- ============================================================
-- SECTION 6: pest_calibration_record_repeating_rows (immutable)
-- ============================================================

create table if not exists public.pest_calibration_record_repeating_rows (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        not null references public.organizations(id) on delete cascade,
  record_id              uuid        not null references public.pest_calibration_records(id) on delete cascade,
  template_field_id      uuid        references public.pest_calibration_template_fields(id) on delete set null,
  group_label_snapshot   text        not null,
  row_index              integer     not null,
  created_at             timestamptz not null default now()
);

create index if not exists pest_calibration_record_repeating_rows_record_idx
  on public.pest_calibration_record_repeating_rows (record_id);

alter table public.pest_calibration_record_repeating_rows enable row level security;

drop policy if exists pest_calibration_record_repeating_rows_select_org on public.pest_calibration_record_repeating_rows;
create policy pest_calibration_record_repeating_rows_select_org on public.pest_calibration_record_repeating_rows
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists pest_calibration_record_repeating_rows_insert_org on public.pest_calibration_record_repeating_rows;
create policy pest_calibration_record_repeating_rows_insert_org on public.pest_calibration_record_repeating_rows
  for insert to authenticated
  with check (public.is_org_member(organization_id));

grant select, insert on table public.pest_calibration_record_repeating_rows to service_role;

-- ============================================================
-- SECTION 7: pest_calibration_record_repeating_answers (immutable)
-- ============================================================

create table if not exists public.pest_calibration_record_repeating_answers (
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

create index if not exists pest_calibration_record_repeating_answers_row_idx
  on public.pest_calibration_record_repeating_answers (repeating_row_id, sort_order);

alter table public.pest_calibration_record_repeating_answers enable row level security;

drop policy if exists pest_calibration_record_repeating_answers_select_org on public.pest_calibration_record_repeating_answers;
create policy pest_calibration_record_repeating_answers_select_org on public.pest_calibration_record_repeating_answers
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists pest_calibration_record_repeating_answers_insert_org on public.pest_calibration_record_repeating_answers;
create policy pest_calibration_record_repeating_answers_insert_org on public.pest_calibration_record_repeating_answers
  for insert to authenticated
  with check (public.is_org_member(organization_id));

grant select, insert on table public.pest_calibration_record_repeating_answers to service_role;

-- ============================================================
-- SECTION 8: immutability trigger
-- ============================================================
-- A new, domain-named function rather than reusing
-- food_safety_prevent_mutation() — that function's hardcoded error message
-- names the wrong domain ("Food Safety report").

create or replace function public.pest_calibration_prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'This row is part of an immutable calibration record and cannot be changed.'
    using errcode = '42501';
end;
$$;

drop trigger if exists pest_calibration_records_immutable on public.pest_calibration_records;
create trigger pest_calibration_records_immutable
  before update or delete on public.pest_calibration_records
  for each row execute function public.pest_calibration_prevent_mutation();

drop trigger if exists pest_calibration_record_answers_immutable on public.pest_calibration_record_answers;
create trigger pest_calibration_record_answers_immutable
  before update or delete on public.pest_calibration_record_answers
  for each row execute function public.pest_calibration_prevent_mutation();

drop trigger if exists pest_calibration_record_repeating_rows_immutable on public.pest_calibration_record_repeating_rows;
create trigger pest_calibration_record_repeating_rows_immutable
  before update or delete on public.pest_calibration_record_repeating_rows
  for each row execute function public.pest_calibration_prevent_mutation();

drop trigger if exists pest_calibration_record_repeating_answers_immutable on public.pest_calibration_record_repeating_answers;
create trigger pest_calibration_record_repeating_answers_immutable
  before update or delete on public.pest_calibration_record_repeating_answers
  for each row execute function public.pest_calibration_prevent_mutation();
