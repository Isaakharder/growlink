create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists memberships_organization_id_idx on public.memberships (organization_id);

alter table public.memberships enable row level security;

drop policy if exists memberships_select_all on public.memberships;
create policy memberships_select_all on public.memberships
  for select
  to public
  using (true);

drop policy if exists memberships_insert_all on public.memberships;
create policy memberships_insert_all on public.memberships
  for insert
  to public
  with check (true);

drop policy if exists memberships_update_all on public.memberships;
create policy memberships_update_all on public.memberships
  for update
  to public
  using (true)
  with check (true);

drop policy if exists memberships_delete_all on public.memberships;
create policy memberships_delete_all on public.memberships
  for delete
  to public
  using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.memberships to anon, authenticated, service_role;