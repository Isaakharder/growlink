create table if not exists public.organization_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  integration_name text not null check (integration_name in ('docklink')),
  external_organization_id text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, integration_name)
);

alter table public.organization_integrations enable row level security;

drop policy if exists organization_integrations_select_all on public.organization_integrations;
create policy organization_integrations_select_all on public.organization_integrations
  for select
  to public
  using (true);

drop policy if exists organization_integrations_insert_all on public.organization_integrations;
create policy organization_integrations_insert_all on public.organization_integrations
  for insert
  to public
  with check (true);

drop policy if exists organization_integrations_update_all on public.organization_integrations;
create policy organization_integrations_update_all on public.organization_integrations
  for update
  to public
  using (true)
  with check (true);

drop policy if exists organization_integrations_delete_all on public.organization_integrations;
create policy organization_integrations_delete_all on public.organization_integrations
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.organization_integrations to anon, authenticated, service_role;
