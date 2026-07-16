-- Food Safety Phase 3: manual record completion, immutable history, and
-- supervisor verification.
--
-- Architecture (see server/src/routes/foodSafety/services/recordRevisions.ts
-- for the TypeScript side of this):
--   A. food_safety_records            — current canonical state (one row per record)
--   B. food_safety_record_revisions   — immutable full snapshots at meaningful lifecycle points
--   C. food_safety_record_audit_events — append-only business-level event log
--   D. food_safety_record_changes     — field-level old/new values for amendments/corrections
--
-- Normal reads only ever touch (A). (B)/(C)/(D) are read for history/audit
-- views and are never required to reconstruct the current record — there is
-- no event-sourcing replay anywhere in this design.

-- ── enable a composite FK from records to (version, its parent template) ───
-- id is already the primary key (globally unique), so this composite unique
-- constraint is trivially satisfiable — it exists purely so
-- food_safety_records can declare a real FK that enforces "the version
-- referenced by a record must belong to the template also referenced by
-- that record" at the database level, not just in application code.
alter table public.food_safety_form_template_versions
  add constraint food_safety_form_template_versions_id_template_key
  unique (id, template_id);

-- ── A. food_safety_records ──────────────────────────────────────────────────

create table public.food_safety_records (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null references public.organizations(id) on delete cascade,
  template_id                 uuid        not null references public.food_safety_form_templates(id) on delete restrict,
  template_version_id         uuid        not null,
  department_id               uuid        references public.food_safety_departments(id) on delete set null,
  location_id                 uuid        references public.food_safety_locations(id) on delete set null,
  status                      text        not null default 'draft'
                                            check (status in ('draft', 'submitted', 'verified', 'rejected', 'amended')),
  answers_json                jsonb       not null default '{}'::jsonb,
  record_date                 date        not null default current_date,
  started_at                  timestamptz not null default now(),
  submitted_at                timestamptz,
  verified_at                 timestamptz,
  rejected_at                 timestamptz,
  completed_by_employee_id    uuid        references public.employees(id) on delete set null,
  completed_by_user_id        uuid        references auth.users(id) on delete set null,
  verified_by_employee_id     uuid        references public.employees(id) on delete set null,
  verified_by_user_id         uuid        references auth.users(id) on delete set null,
  rejected_by_user_id         uuid        references auth.users(id) on delete set null,
  rejection_reason            text,
  current_revision_number     integer     not null default 0 check (current_revision_number >= 0),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- Enforces "template_id must match the version's parent template" at the
  -- DB level via the composite unique constraint added above.
  constraint food_safety_records_version_template_fk
    foreign key (template_version_id, template_id)
    references public.food_safety_form_template_versions (id, template_id)
    on delete restrict
);

create index food_safety_records_org_idx on public.food_safety_records (organization_id);
create index food_safety_records_org_status_idx on public.food_safety_records (organization_id, status);
create index food_safety_records_org_template_idx on public.food_safety_records (organization_id, template_id);
create index food_safety_records_org_department_idx on public.food_safety_records (organization_id, department_id);
create index food_safety_records_org_completed_by_user_idx on public.food_safety_records (organization_id, completed_by_user_id);
create index food_safety_records_org_completed_by_employee_idx on public.food_safety_records (organization_id, completed_by_employee_id);
create index food_safety_records_org_record_date_idx on public.food_safety_records (organization_id, record_date);

alter table public.food_safety_records enable row level security;

create policy food_safety_records_select_org on public.food_safety_records
  for select to authenticated using (public.is_org_member(organization_id));
create policy food_safety_records_insert_org on public.food_safety_records
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy food_safety_records_update_org on public.food_safety_records
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy food_safety_records_delete_org on public.food_safety_records
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_records to service_role;

-- ── B. food_safety_record_revisions (immutable) ─────────────────────────────

create table public.food_safety_record_revisions (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete cascade,
  record_id                 uuid        not null references public.food_safety_records(id) on delete cascade,
  revision_number           integer     not null check (revision_number >= 1),
  status_snapshot           text        not null,
  answers_snapshot          jsonb       not null,
  template_schema_snapshot  jsonb       not null,
  metadata_snapshot         jsonb       not null default '{}'::jsonb,
  reason                    text,
  created_by_user_id        uuid        references auth.users(id) on delete set null,
  created_by_employee_id    uuid        references public.employees(id) on delete set null,
  created_at                timestamptz not null default now(),
  constraint food_safety_record_revisions_record_number_key unique (record_id, revision_number)
);

create index food_safety_record_revisions_org_idx on public.food_safety_record_revisions (organization_id);

alter table public.food_safety_record_revisions enable row level security;

create policy food_safety_record_revisions_select_org on public.food_safety_record_revisions
  for select to authenticated using (public.is_org_member(organization_id));
create policy food_safety_record_revisions_insert_org on public.food_safety_record_revisions
  for insert to authenticated with check (public.is_org_member(organization_id));

grant select, insert on table public.food_safety_record_revisions to service_role;

-- ── C. food_safety_record_audit_events (append-only) ────────────────────────

create table public.food_safety_record_audit_events (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  record_id         uuid        not null references public.food_safety_records(id) on delete cascade,
  event_type        text        not null check (event_type in (
                                  'record_created', 'draft_saved', 'submitted', 'verified', 'rejected',
                                  'amendment_started', 'amended', 'resubmitted', 'viewed', 'archived'
                                )),
  actor_user_id     uuid        references auth.users(id) on delete set null,
  actor_employee_id uuid        references public.employees(id) on delete set null,
  event_metadata    jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index food_safety_record_audit_events_org_idx on public.food_safety_record_audit_events (organization_id);
create index food_safety_record_audit_events_record_idx on public.food_safety_record_audit_events (record_id, created_at);

alter table public.food_safety_record_audit_events enable row level security;

create policy food_safety_record_audit_events_select_org on public.food_safety_record_audit_events
  for select to authenticated using (public.is_org_member(organization_id));
create policy food_safety_record_audit_events_insert_org on public.food_safety_record_audit_events
  for insert to authenticated with check (public.is_org_member(organization_id));

grant select, insert on table public.food_safety_record_audit_events to service_role;

-- ── D. food_safety_record_changes (append-only, field-level) ───────────────

create table public.food_safety_record_changes (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         uuid        not null references public.organizations(id) on delete cascade,
  record_id               uuid        not null references public.food_safety_records(id) on delete cascade,
  from_revision_number    integer     not null,
  to_revision_number      integer     not null,
  field_id                text,
  old_value               jsonb,
  new_value               jsonb,
  change_reason           text        not null,
  changed_by_user_id      uuid        references auth.users(id) on delete set null,
  changed_by_employee_id  uuid        references public.employees(id) on delete set null,
  created_at              timestamptz not null default now()
);

create index food_safety_record_changes_org_idx on public.food_safety_record_changes (organization_id);
create index food_safety_record_changes_record_idx on public.food_safety_record_changes (record_id);

alter table public.food_safety_record_changes enable row level security;

create policy food_safety_record_changes_select_org on public.food_safety_record_changes
  for select to authenticated using (public.is_org_member(organization_id));
create policy food_safety_record_changes_insert_org on public.food_safety_record_changes
  for insert to authenticated with check (public.is_org_member(organization_id));

grant select, insert on table public.food_safety_record_changes to service_role;

-- ── immutability guard ───────────────────────────────────────────────────────
-- A narrow, generic trigger (not business logic) that unconditionally
-- rejects UPDATE/DELETE on the three append-only tables above, so a future
-- bug in service-layer code can never silently rewrite history — only
-- INSERT is ever permitted on these tables after this migration.

create or replace function public.food_safety_prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'This row is part of an immutable Food Safety audit trail and cannot be changed.'
    using errcode = '42501';
end;
$$;

create trigger food_safety_record_revisions_immutable
  before update or delete on public.food_safety_record_revisions
  for each row execute function public.food_safety_prevent_mutation();

create trigger food_safety_record_audit_events_immutable
  before update or delete on public.food_safety_record_audit_events
  for each row execute function public.food_safety_prevent_mutation();

create trigger food_safety_record_changes_immutable
  before update or delete on public.food_safety_record_changes
  for each row execute function public.food_safety_prevent_mutation();

-- ── lifecycle RPC functions ──────────────────────────────────────────────────
--
-- Each of the five functions below performs one lifecycle transition as a
-- single atomic operation: lock the record row, validate its current status,
-- update the canonical record, insert an immutable revision snapshot, insert
-- audit event(s), and (for resubmit/amend) insert field-level change rows.
-- Supabase's REST client has no multi-statement transaction primitive, so —
-- exactly as in migration 0076's food_safety_create_draft_version — a single
-- SQL function call is what makes "update + revision + audit event" atomic
-- from the caller's point of view. pg_advisory_xact_lock serializes
-- concurrent transitions on the same record (e.g. two supervisors tapping
-- "Verify" at the same moment), and the status check inside each function
-- (re-read under the lock) is the real guard against a double-transition —
-- the lock only makes that check race-free.
--
-- Metadata/schema snapshots and answer-diff computation (which fields
-- changed) are deliberately NOT done in SQL — they are assembled in
-- TypeScript (services/recordRevisions.ts) where that logic is easy to unit
-- test, then passed in as plain parameters for these functions to store
-- atomically alongside the status transition.

create or replace function public.food_safety_submit_record(
  p_organization_id uuid,
  p_record_id uuid,
  p_answers_json jsonb,
  p_completed_by_employee_id uuid,
  p_completed_by_user_id uuid,
  p_requires_verification boolean,
  p_metadata_snapshot jsonb
)
returns public.food_safety_records
language plpgsql
as $$
declare
  v_record public.food_safety_records;
  v_schema_json jsonb;
  v_next_revision integer;
  v_now timestamptz := now();
  v_new_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_record_id::text, 1));

  select * into v_record from public.food_safety_records
  where id = p_record_id and organization_id = p_organization_id
  for update;

  if v_record.id is null then
    raise exception 'Record % not found in organization %', p_record_id, p_organization_id using errcode = 'P0002';
  end if;

  if v_record.status <> 'draft' then
    raise exception 'Record is not a draft and cannot be submitted';
  end if;

  select schema_json into v_schema_json
  from public.food_safety_form_template_versions where id = v_record.template_version_id;

  v_new_status := case when p_requires_verification then 'submitted' else 'verified' end;
  v_next_revision := v_record.current_revision_number + 1;

  update public.food_safety_records
  set answers_json = p_answers_json,
      status = v_new_status,
      submitted_at = v_now,
      completed_by_employee_id = p_completed_by_employee_id,
      completed_by_user_id = p_completed_by_user_id,
      verified_at = case when not p_requires_verification then v_now else null end,
      verified_by_employee_id = null,
      verified_by_user_id = null,
      current_revision_number = v_next_revision,
      updated_at = v_now
  where id = p_record_id
  returning * into v_record;

  insert into public.food_safety_record_revisions (
    organization_id, record_id, revision_number, status_snapshot,
    answers_snapshot, template_schema_snapshot, metadata_snapshot,
    created_by_user_id, created_by_employee_id
  ) values (
    p_organization_id, p_record_id, v_next_revision, v_new_status,
    p_answers_json, v_schema_json, p_metadata_snapshot,
    p_completed_by_user_id, p_completed_by_employee_id
  );

  insert into public.food_safety_record_audit_events (
    organization_id, record_id, event_type, actor_user_id, actor_employee_id, event_metadata
  ) values (
    p_organization_id, p_record_id, 'submitted', p_completed_by_user_id, p_completed_by_employee_id,
    jsonb_build_object('revision_number', v_next_revision)
  );

  if not p_requires_verification then
    insert into public.food_safety_record_audit_events (
      organization_id, record_id, event_type, event_metadata
    ) values (
      p_organization_id, p_record_id, 'verified',
      jsonb_build_object('revision_number', v_next_revision, 'auto_verified', true)
    );
  end if;

  return v_record;
end;
$$;

create or replace function public.food_safety_verify_record(
  p_organization_id uuid,
  p_record_id uuid,
  p_verified_by_user_id uuid,
  p_verified_by_employee_id uuid,
  p_metadata_snapshot jsonb
)
returns public.food_safety_records
language plpgsql
as $$
declare
  v_record public.food_safety_records;
  v_schema_json jsonb;
  v_next_revision integer;
  v_now timestamptz := now();
begin
  perform pg_advisory_xact_lock(hashtextextended(p_record_id::text, 1));

  select * into v_record from public.food_safety_records
  where id = p_record_id and organization_id = p_organization_id
  for update;

  if v_record.id is null then
    raise exception 'Record % not found in organization %', p_record_id, p_organization_id using errcode = 'P0002';
  end if;

  if v_record.status not in ('submitted', 'amended') then
    raise exception 'Record is not awaiting verification';
  end if;

  -- Self-verification is never allowed, for any role — checked here (the
  -- authoritative guarantee) in addition to the application layer.
  if p_verified_by_user_id is not null and v_record.completed_by_user_id = p_verified_by_user_id then
    raise exception 'You cannot verify your own submitted record' using errcode = '42501';
  end if;
  if p_verified_by_employee_id is not null and v_record.completed_by_employee_id = p_verified_by_employee_id then
    raise exception 'You cannot verify your own submitted record' using errcode = '42501';
  end if;

  select schema_json into v_schema_json
  from public.food_safety_form_template_versions where id = v_record.template_version_id;

  v_next_revision := v_record.current_revision_number + 1;

  update public.food_safety_records
  set status = 'verified',
      verified_at = v_now,
      verified_by_user_id = p_verified_by_user_id,
      verified_by_employee_id = p_verified_by_employee_id,
      rejected_at = null, rejected_by_user_id = null, rejection_reason = null,
      current_revision_number = v_next_revision,
      updated_at = v_now
  where id = p_record_id
  returning * into v_record;

  insert into public.food_safety_record_revisions (
    organization_id, record_id, revision_number, status_snapshot,
    answers_snapshot, template_schema_snapshot, metadata_snapshot,
    created_by_user_id, created_by_employee_id
  ) values (
    p_organization_id, p_record_id, v_next_revision, 'verified',
    v_record.answers_json, v_schema_json, p_metadata_snapshot,
    p_verified_by_user_id, p_verified_by_employee_id
  );

  insert into public.food_safety_record_audit_events (
    organization_id, record_id, event_type, actor_user_id, actor_employee_id, event_metadata
  ) values (
    p_organization_id, p_record_id, 'verified', p_verified_by_user_id, p_verified_by_employee_id,
    jsonb_build_object('revision_number', v_next_revision)
  );

  return v_record;
end;
$$;

create or replace function public.food_safety_reject_record(
  p_organization_id uuid,
  p_record_id uuid,
  p_rejected_by_user_id uuid,
  p_rejection_reason text,
  p_metadata_snapshot jsonb
)
returns public.food_safety_records
language plpgsql
as $$
declare
  v_record public.food_safety_records;
  v_schema_json jsonb;
  v_next_revision integer;
  v_now timestamptz := now();
begin
  if p_rejection_reason is null or length(trim(p_rejection_reason)) = 0 then
    raise exception 'A rejection reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_record_id::text, 1));

  select * into v_record from public.food_safety_records
  where id = p_record_id and organization_id = p_organization_id
  for update;

  if v_record.id is null then
    raise exception 'Record % not found in organization %', p_record_id, p_organization_id using errcode = 'P0002';
  end if;

  if v_record.status not in ('submitted', 'amended') then
    raise exception 'Record is not awaiting verification and cannot be rejected';
  end if;

  select schema_json into v_schema_json
  from public.food_safety_form_template_versions where id = v_record.template_version_id;

  v_next_revision := v_record.current_revision_number + 1;

  update public.food_safety_records
  set status = 'rejected',
      rejected_at = v_now,
      rejected_by_user_id = p_rejected_by_user_id,
      rejection_reason = p_rejection_reason,
      current_revision_number = v_next_revision,
      updated_at = v_now
  where id = p_record_id
  returning * into v_record;

  insert into public.food_safety_record_revisions (
    organization_id, record_id, revision_number, status_snapshot,
    answers_snapshot, template_schema_snapshot, metadata_snapshot, reason,
    created_by_user_id
  ) values (
    p_organization_id, p_record_id, v_next_revision, 'rejected',
    v_record.answers_json, v_schema_json, p_metadata_snapshot, p_rejection_reason,
    p_rejected_by_user_id
  );

  insert into public.food_safety_record_audit_events (
    organization_id, record_id, event_type, actor_user_id, event_metadata
  ) values (
    p_organization_id, p_record_id, 'rejected', p_rejected_by_user_id,
    jsonb_build_object('revision_number', v_next_revision, 'reason', p_rejection_reason)
  );

  return v_record;
end;
$$;

create or replace function public.food_safety_resubmit_record(
  p_organization_id uuid,
  p_record_id uuid,
  p_answers_json jsonb,
  p_completed_by_employee_id uuid,
  p_completed_by_user_id uuid,
  p_requires_verification boolean,
  p_change_reason text,
  p_changes jsonb,
  p_metadata_snapshot jsonb
)
returns public.food_safety_records
language plpgsql
as $$
declare
  v_record public.food_safety_records;
  v_schema_json jsonb;
  v_next_revision integer;
  v_prev_revision integer;
  v_now timestamptz := now();
  v_new_status text;
  v_change jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_record_id::text, 1));

  select * into v_record from public.food_safety_records
  where id = p_record_id and organization_id = p_organization_id
  for update;

  if v_record.id is null then
    raise exception 'Record % not found in organization %', p_record_id, p_organization_id using errcode = 'P0002';
  end if;

  if v_record.status <> 'rejected' then
    raise exception 'Record is not rejected and cannot be resubmitted';
  end if;

  if p_changes is not null and jsonb_array_length(p_changes) > 0
     and (p_change_reason is null or length(trim(p_change_reason)) = 0) then
    raise exception 'A change reason is required when answers have changed';
  end if;

  select schema_json into v_schema_json
  from public.food_safety_form_template_versions where id = v_record.template_version_id;

  v_prev_revision := v_record.current_revision_number;
  v_next_revision := v_prev_revision + 1;
  v_new_status := case when p_requires_verification then 'submitted' else 'verified' end;

  update public.food_safety_records
  set answers_json = p_answers_json,
      status = v_new_status,
      submitted_at = v_now,
      completed_by_employee_id = p_completed_by_employee_id,
      completed_by_user_id = p_completed_by_user_id,
      rejected_at = null, rejected_by_user_id = null, rejection_reason = null,
      verified_at = case when not p_requires_verification then v_now else null end,
      verified_by_employee_id = null,
      verified_by_user_id = null,
      current_revision_number = v_next_revision,
      updated_at = v_now
  where id = p_record_id
  returning * into v_record;

  insert into public.food_safety_record_revisions (
    organization_id, record_id, revision_number, status_snapshot,
    answers_snapshot, template_schema_snapshot, metadata_snapshot, reason,
    created_by_user_id, created_by_employee_id
  ) values (
    p_organization_id, p_record_id, v_next_revision, v_new_status,
    p_answers_json, v_schema_json, p_metadata_snapshot, p_change_reason,
    p_completed_by_user_id, p_completed_by_employee_id
  );

  insert into public.food_safety_record_audit_events (
    organization_id, record_id, event_type, actor_user_id, actor_employee_id, event_metadata
  ) values (
    p_organization_id, p_record_id, 'resubmitted', p_completed_by_user_id, p_completed_by_employee_id,
    jsonb_build_object('revision_number', v_next_revision)
  );

  if not p_requires_verification then
    insert into public.food_safety_record_audit_events (
      organization_id, record_id, event_type, event_metadata
    ) values (
      p_organization_id, p_record_id, 'verified',
      jsonb_build_object('revision_number', v_next_revision, 'auto_verified', true)
    );
  end if;

  if p_changes is not null then
    for v_change in select * from jsonb_array_elements(p_changes)
    loop
      insert into public.food_safety_record_changes (
        organization_id, record_id, from_revision_number, to_revision_number,
        field_id, old_value, new_value, change_reason, changed_by_user_id, changed_by_employee_id
      ) values (
        p_organization_id, p_record_id, v_prev_revision, v_next_revision,
        v_change ->> 'field_id', v_change -> 'old_value', v_change -> 'new_value',
        coalesce(p_change_reason, 'Corrected after rejection'), p_completed_by_user_id, p_completed_by_employee_id
      );
    end loop;
  end if;

  return v_record;
end;
$$;

create or replace function public.food_safety_amend_record(
  p_organization_id uuid,
  p_record_id uuid,
  p_answers_json jsonb,
  p_amended_by_employee_id uuid,
  p_amended_by_user_id uuid,
  p_reason text,
  p_changes jsonb,
  p_metadata_snapshot jsonb
)
returns public.food_safety_records
language plpgsql
as $$
declare
  v_record public.food_safety_records;
  v_schema_json jsonb;
  v_next_revision integer;
  v_prev_revision integer;
  v_now timestamptz := now();
  v_change jsonb;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'An amendment reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_record_id::text, 1));

  select * into v_record from public.food_safety_records
  where id = p_record_id and organization_id = p_organization_id
  for update;

  if v_record.id is null then
    raise exception 'Record % not found in organization %', p_record_id, p_organization_id using errcode = 'P0002';
  end if;

  if v_record.status not in ('submitted', 'verified', 'amended') then
    raise exception 'Only a submitted, verified, or previously amended record can be amended';
  end if;

  select schema_json into v_schema_json
  from public.food_safety_form_template_versions where id = v_record.template_version_id;

  v_prev_revision := v_record.current_revision_number;
  v_next_revision := v_prev_revision + 1;

  insert into public.food_safety_record_audit_events (
    organization_id, record_id, event_type, actor_user_id, actor_employee_id, event_metadata
  ) values (
    p_organization_id, p_record_id, 'amendment_started', p_amended_by_user_id, p_amended_by_employee_id,
    jsonb_build_object('from_revision_number', v_prev_revision)
  );

  -- Invalidates any prior verification unconditionally, regardless of the
  -- record's status before this call — a verified record must never keep
  -- its old verification after its answers change underneath it.
  update public.food_safety_records
  set answers_json = p_answers_json,
      status = 'amended',
      verified_at = null,
      verified_by_employee_id = null,
      verified_by_user_id = null,
      current_revision_number = v_next_revision,
      updated_at = v_now
  where id = p_record_id
  returning * into v_record;

  insert into public.food_safety_record_revisions (
    organization_id, record_id, revision_number, status_snapshot,
    answers_snapshot, template_schema_snapshot, metadata_snapshot, reason,
    created_by_user_id, created_by_employee_id
  ) values (
    p_organization_id, p_record_id, v_next_revision, 'amended',
    p_answers_json, v_schema_json, p_metadata_snapshot, p_reason,
    p_amended_by_user_id, p_amended_by_employee_id
  );

  insert into public.food_safety_record_audit_events (
    organization_id, record_id, event_type, actor_user_id, actor_employee_id, event_metadata
  ) values (
    p_organization_id, p_record_id, 'amended', p_amended_by_user_id, p_amended_by_employee_id,
    jsonb_build_object('revision_number', v_next_revision, 'reason', p_reason)
  );

  if p_changes is not null then
    for v_change in select * from jsonb_array_elements(p_changes)
    loop
      insert into public.food_safety_record_changes (
        organization_id, record_id, from_revision_number, to_revision_number,
        field_id, old_value, new_value, change_reason, changed_by_user_id, changed_by_employee_id
      ) values (
        p_organization_id, p_record_id, v_prev_revision, v_next_revision,
        v_change ->> 'field_id', v_change -> 'old_value', v_change -> 'new_value',
        p_reason, p_amended_by_user_id, p_amended_by_employee_id
      );
    end loop;
  end if;

  return v_record;
end;
$$;

grant execute on function public.food_safety_submit_record(uuid, uuid, jsonb, uuid, uuid, boolean, jsonb) to service_role;
grant execute on function public.food_safety_verify_record(uuid, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.food_safety_reject_record(uuid, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.food_safety_resubmit_record(uuid, uuid, jsonb, uuid, uuid, boolean, text, jsonb, jsonb) to service_role;
grant execute on function public.food_safety_amend_record(uuid, uuid, jsonb, uuid, uuid, text, jsonb, jsonb) to service_role;
