-- Food Safety Phase 2: generic, versioned form-template engine.
--
-- food_safety_form_templates is the permanent LOGICAL identity of a form
-- (its name, department, CanadaGAP section, etc). Editing this row never
-- touches historical version content.
--
-- food_safety_form_template_versions holds the actual renderable form
-- definition as a JSONB blob (schema_json). Each version is either a
-- 'draft' (editable) or 'published' (frozen forever). The published
-- version's schema_json itself carries title/description/instructions
-- snapshots (see FoodSafetyFormSchema in
-- server/src/routes/foodSafety/services/templateSchema.ts) — this is a
-- deliberate design choice: the version row does NOT duplicate
-- template.name/description/instructions in separate snapshot columns,
-- because the entire point of schema_json is to be a fully self-contained,
-- render-anywhere snapshot. A later template rename/re-department never
-- alters what a previously published version renders as.

create table if not exists public.food_safety_form_templates (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  department_id     uuid        references public.food_safety_departments(id) on delete set null,
  name              text        not null,
  description       text,
  form_code         text,
  canadagap_section text,
  instructions      text,
  active            boolean     not null default true,
  sort_order        integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint food_safety_form_templates_org_name_key unique (organization_id, name)
);

create index if not exists food_safety_form_templates_org_idx
  on public.food_safety_form_templates (organization_id);

create index if not exists food_safety_form_templates_department_idx
  on public.food_safety_form_templates (organization_id, department_id);

create index if not exists food_safety_form_templates_org_active_sort_idx
  on public.food_safety_form_templates (organization_id, active, sort_order);

-- form_code is optional but must be unique per organization when present.
create unique index if not exists food_safety_form_templates_org_form_code_key
  on public.food_safety_form_templates (organization_id, form_code)
  where form_code is not null;

alter table public.food_safety_form_templates enable row level security;

drop policy if exists food_safety_form_templates_select_org on public.food_safety_form_templates;
create policy food_safety_form_templates_select_org on public.food_safety_form_templates
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_form_templates_insert_org on public.food_safety_form_templates;
create policy food_safety_form_templates_insert_org on public.food_safety_form_templates
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_form_templates_update_org on public.food_safety_form_templates;
create policy food_safety_form_templates_update_org on public.food_safety_form_templates
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_form_templates_delete_org on public.food_safety_form_templates;
create policy food_safety_form_templates_delete_org on public.food_safety_form_templates
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_form_templates to service_role;


create table if not exists public.food_safety_form_template_versions (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        not null references public.organizations(id) on delete cascade,
  template_id           uuid        not null references public.food_safety_form_templates(id) on delete cascade,
  version_number        integer     not null check (version_number >= 1),
  status                text        not null default 'draft'
                                      check (status in ('draft', 'published', 'archived')),
  schema_json           jsonb       not null,
  version_notes         text,
  created_by_user_id    uuid        references auth.users(id) on delete set null,
  published_by_user_id  uuid        references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  published_at          timestamptz,
  constraint food_safety_form_template_versions_template_version_key
    unique (template_id, version_number)
);

create index if not exists food_safety_form_template_versions_org_idx
  on public.food_safety_form_template_versions (organization_id);

create index if not exists food_safety_form_template_versions_template_idx
  on public.food_safety_form_template_versions (template_id, version_number desc);

create index if not exists food_safety_form_template_versions_template_status_idx
  on public.food_safety_form_template_versions (template_id, status);

-- At most one draft per template. Publishing moves a row out of 'draft',
-- so this index never blocks a legitimate publish -> new-draft cycle; it
-- only ever blocks a second concurrent/accidental draft on the same
-- template. This is the primary defense against "silently overwriting an
-- existing draft" — the app layer also checks for this explicitly, but the
-- constraint is what makes the guarantee real under concurrency.
create unique index if not exists food_safety_form_template_versions_one_draft_idx
  on public.food_safety_form_template_versions (template_id)
  where status = 'draft';

alter table public.food_safety_form_template_versions enable row level security;

drop policy if exists food_safety_form_template_versions_select_org on public.food_safety_form_template_versions;
create policy food_safety_form_template_versions_select_org on public.food_safety_form_template_versions
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_form_template_versions_insert_org on public.food_safety_form_template_versions;
create policy food_safety_form_template_versions_insert_org on public.food_safety_form_template_versions
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_form_template_versions_update_org on public.food_safety_form_template_versions;
create policy food_safety_form_template_versions_update_org on public.food_safety_form_template_versions
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_form_template_versions_delete_org on public.food_safety_form_template_versions;
create policy food_safety_form_template_versions_delete_org on public.food_safety_form_template_versions
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_form_template_versions to service_role;


-- Atomically assigns the next version_number and creates a new draft row.
-- Used both for a template's very first version and for cloning a new
-- draft from an existing (typically published) version.
--
-- Supabase's REST client has no multi-statement transaction primitive, so
-- "read max(version_number), then insert" from two separate HTTP round
-- trips would be racy under concurrent requests. A single SQL function
-- executes as one statement from the caller's point of view (implicitly
-- atomic), and the pg_advisory_xact_lock below additionally serializes
-- concurrent calls for the *same* template so two simultaneous "create
-- version" requests can never compute the same next version_number or
-- both slip past the one-draft-per-template check. The lock is released
-- automatically at the end of the (implicit) transaction.
--
-- The unique index above is the final backstop if this function is ever
-- bypassed or called incorrectly.
create or replace function public.food_safety_create_draft_version(
  p_organization_id uuid,
  p_template_id uuid,
  p_schema_json jsonb,
  p_version_notes text,
  p_created_by_user_id uuid
)
returns public.food_safety_form_template_versions
language plpgsql
as $$
declare
  v_next_version integer;
  v_existing_draft_id uuid;
  v_row public.food_safety_form_template_versions;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_template_id::text, 0));

  if not exists (
    select 1 from public.food_safety_form_templates
    where id = p_template_id and organization_id = p_organization_id
  ) then
    raise exception 'Template % not found in organization %', p_template_id, p_organization_id
      using errcode = 'P0002';
  end if;

  select id into v_existing_draft_id
  from public.food_safety_form_template_versions
  where template_id = p_template_id and status = 'draft'
  limit 1;

  if v_existing_draft_id is not null then
    raise exception 'A draft version already exists for this template'
      using errcode = '23505';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next_version
  from public.food_safety_form_template_versions
  where template_id = p_template_id;

  insert into public.food_safety_form_template_versions (
    organization_id, template_id, version_number, status,
    schema_json, version_notes, created_by_user_id
  ) values (
    p_organization_id, p_template_id, v_next_version, 'draft',
    p_schema_json, p_version_notes, p_created_by_user_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.food_safety_create_draft_version(uuid, uuid, jsonb, text, uuid) to service_role;
