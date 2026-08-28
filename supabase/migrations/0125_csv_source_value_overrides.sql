-- "Pending data only" label resolutions for the CSV-template pending-import
-- weekly review cards. Lets a user resolve an unrecognized raw value (e.g. a
-- FlowMaster MARKET label like "Green" or "Doubles") for one or more
-- specific already-uploaded source files WITHOUT creating a new version of
-- the matched csv_mapping_templates row. Consulted additively by the engine
-- config builder (server/src/routes/csvMappingTemplates.ts) on top of the
-- matched template's own value_mappings — an override here always wins for
-- the same (source_field, raw_value) pair, but never mutates the template.

create table public.csv_source_value_overrides (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  source_file_id        uuid not null references public.csv_import_source_files(id) on delete cascade,
  source_field          text not null check (source_field in ('size_label', 'market_grade')),
  raw_value             text not null,
  action                text not null check (action in ('map', 'ignore', 'distribute')),
  target_size_id        uuid null references public.yield_sizes(id) on delete set null,
  distribute_size_ids   jsonb null,
  created_by            uuid null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index csv_source_value_overrides_org_source_field_value_idx
  on public.csv_source_value_overrides (organization_id, source_file_id, source_field, raw_value);

create index csv_source_value_overrides_org_source_idx
  on public.csv_source_value_overrides (organization_id, source_file_id);

alter table public.csv_source_value_overrides enable row level security;

create policy csv_source_value_overrides_select_org on public.csv_source_value_overrides
  for select to authenticated using (public.is_org_member(organization_id));

create policy csv_source_value_overrides_insert_org on public.csv_source_value_overrides
  for insert to authenticated with check (public.is_org_member(organization_id));

create policy csv_source_value_overrides_update_org on public.csv_source_value_overrides
  for update to authenticated using (public.is_org_member(organization_id));

create policy csv_source_value_overrides_delete_org on public.csv_source_value_overrides
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.csv_source_value_overrides to service_role;
