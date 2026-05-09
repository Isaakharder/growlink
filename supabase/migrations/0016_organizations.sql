create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organizations enable row level security;

drop policy if exists organizations_select_all on public.organizations;
create policy organizations_select_all on public.organizations
  for select
  to public
  using (true);

drop policy if exists organizations_insert_all on public.organizations;
create policy organizations_insert_all on public.organizations
  for insert
  to public
  with check (true);

drop policy if exists organizations_update_all on public.organizations;
create policy organizations_update_all on public.organizations
  for update
  to public
  using (true)
  with check (true);

drop policy if exists organizations_delete_all on public.organizations;
create policy organizations_delete_all on public.organizations
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.organizations to anon, authenticated, service_role;