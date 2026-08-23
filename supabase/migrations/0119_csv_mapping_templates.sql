-- Generic, organization-configurable CSV import template system (the "CSV
-- Import Template Builder"). Distinct from import_source_templates
-- (0063/0065), which is a GrowLink-staff-only, one-per-upload-key admin
-- tool for weather-station/legacy generic_csv imports and is not touched
-- by this feature.
--
-- Editing a template inserts a new row (version + 1, same
-- template_group_id, is_current = true) rather than mutating the existing
-- row in place, so earlier imports remain reproducible against the exact
-- template version that produced them.

create table public.csv_mapping_templates (
  id                    uuid primary key default gen_random_uuid(),
  template_group_id     uuid not null,
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  name                  text not null,
  version               int not null default 1,
  is_current            boolean not null default true,
  is_active             boolean not null default true,
  delimiter             text not null default ',',
  encoding              text not null default 'utf-8',
  header_row_index      int not null,
  data_start_row_index  int not null,
  data_end_row_index    int null,
  skip_row_indexes      int[] not null default '{}',
  blank_row_behavior    text not null default 'skip' check (blank_row_behavior in ('skip', 'stop')),
  fingerprint           jsonb not null,
  fingerprint_hash      text not null,
  column_mappings       jsonb not null default '[]',
  fixed_cell_mappings   jsonb not null default '[]',
  value_mappings        jsonb not null default '[]',
  rules                 jsonb not null default '[]',
  created_by            uuid not null,
  updated_by            uuid not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index csv_mapping_templates_org_idx on public.csv_mapping_templates (organization_id);
create index csv_mapping_templates_group_idx on public.csv_mapping_templates (template_group_id);

-- One active, current template per exact structural layout per org, so
-- auto-recognition on upload is never ambiguous.
create unique index csv_mapping_templates_org_fingerprint_current_idx
  on public.csv_mapping_templates (organization_id, fingerprint_hash)
  where is_current and is_active;

alter table public.csv_mapping_templates enable row level security;

create policy csv_mapping_templates_select_org on public.csv_mapping_templates
  for select to authenticated using (public.is_org_member(organization_id));

create policy csv_mapping_templates_insert_org on public.csv_mapping_templates
  for insert to authenticated with check (public.is_org_member(organization_id));

create policy csv_mapping_templates_update_org on public.csv_mapping_templates
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy csv_mapping_templates_delete_org on public.csv_mapping_templates
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.csv_mapping_templates to service_role;
