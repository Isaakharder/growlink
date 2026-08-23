-- Links agent_pending_imports / yield_import_runs to the new CSV Template
-- Builder tables. Adds a third data_source_type value ('csv_template')
-- alongside the existing 'flowmaster' and 'generic_csv' — the FlowMaster
-- pipeline and the legacy generic_csv/import_source_templates pipeline are
-- both left exactly as they behave today.

alter table public.agent_pending_imports
  drop constraint agent_pending_imports_data_source_type_check;

alter table public.agent_pending_imports
  add constraint agent_pending_imports_data_source_type_check
  check (data_source_type in ('flowmaster', 'generic_csv', 'csv_template'));

alter table public.agent_pending_imports
  add column csv_mapping_template_id uuid null references public.csv_mapping_templates(id) on delete set null;

alter table public.agent_pending_imports
  add column source_file_id uuid null references public.csv_import_source_files(id) on delete set null;

create index agent_pending_imports_csv_template_idx
  on public.agent_pending_imports (csv_mapping_template_id)
  where csv_mapping_template_id is not null;

alter table public.yield_import_runs
  add column csv_mapping_template_id uuid null references public.csv_mapping_templates(id) on delete set null;

alter table public.yield_import_runs
  add column source_file_id uuid null references public.csv_import_source_files(id) on delete set null;

create index yield_import_runs_source_file_idx
  on public.yield_import_runs (source_file_id)
  where source_file_id is not null;
