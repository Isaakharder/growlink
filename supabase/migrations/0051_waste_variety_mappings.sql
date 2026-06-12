create table if not exists public.waste_variety_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  external_variety_id text not null,
  external_variety_name text,
  variety_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_variety_id)
);

create index waste_variety_mappings_organization_id_idx on public.waste_variety_mappings (organization_id);

alter table public.waste_variety_mappings enable row level security;

drop policy if exists waste_variety_mappings_select_all on public.waste_variety_mappings;
create policy waste_variety_mappings_select_all on public.waste_variety_mappings
  for select to public using (true);

drop policy if exists waste_variety_mappings_insert_all on public.waste_variety_mappings;
create policy waste_variety_mappings_insert_all on public.waste_variety_mappings
  for insert to public with check (true);

drop policy if exists waste_variety_mappings_update_all on public.waste_variety_mappings;
create policy waste_variety_mappings_update_all on public.waste_variety_mappings
  for update to public using (true) with check (true);

drop policy if exists waste_variety_mappings_delete_all on public.waste_variety_mappings;
create policy waste_variety_mappings_delete_all on public.waste_variety_mappings
  for delete to public using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.waste_variety_mappings to anon, authenticated, service_role;
