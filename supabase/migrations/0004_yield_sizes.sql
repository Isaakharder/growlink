create extension if not exists pgcrypto;

create table if not exists public.yield_sizes (
	id uuid primary key default gen_random_uuid(),
	name text not null,
	sort_order integer not null default 0 check (sort_order >= 0),
	status text not null default 'active' check (status in ('active', 'inactive')),
	created_at timestamptz default now(),
	updated_at timestamptz default now()
);

alter table public.yield_sizes enable row level security;

drop policy if exists yield_sizes_select_all on public.yield_sizes;
create policy yield_sizes_select_all on public.yield_sizes
	for select
	to public
	using (true);

drop policy if exists yield_sizes_insert_all on public.yield_sizes;
create policy yield_sizes_insert_all on public.yield_sizes
	for insert
	to public
	with check (true);

drop policy if exists yield_sizes_update_all on public.yield_sizes;
create policy yield_sizes_update_all on public.yield_sizes
	for update
	to public
	using (true)
	with check (true);

drop policy if exists yield_sizes_delete_all on public.yield_sizes;
create policy yield_sizes_delete_all on public.yield_sizes
	for delete
	to public
	using (true);

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.yield_sizes to anon, authenticated, service_role;