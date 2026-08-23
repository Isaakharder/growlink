-- Raw CSV text store for the CSV Import Template Builder, content-deduped
-- per organization. Mirrors the raw_payload.csv_text preservation pattern
-- already used by agent_pending_imports, but as its own referenced table so
-- completed import records (yield_import_runs, which are never deleted) can
-- also point back to their original source without duplicating the text.

create table public.csv_import_source_files (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  file_hash        text not null,
  filename         text not null,
  raw_text         text not null,
  row_count        int not null,
  column_count     int not null,
  delimiter        text not null,
  uploaded_at      timestamptz not null default now(),
  uploaded_by      uuid null
);

create unique index csv_import_source_files_org_hash_idx
  on public.csv_import_source_files (organization_id, file_hash);

create index csv_import_source_files_org_idx
  on public.csv_import_source_files (organization_id);

alter table public.csv_import_source_files enable row level security;

create policy csv_import_source_files_select_org on public.csv_import_source_files
  for select to authenticated using (public.is_org_member(organization_id));

create policy csv_import_source_files_insert_org on public.csv_import_source_files
  for insert to authenticated with check (public.is_org_member(organization_id));

create policy csv_import_source_files_delete_org on public.csv_import_source_files
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.csv_import_source_files to service_role;
