-- Migration 0037: Link greenhouse rows to irrigation feed valves.
-- Each row maps to at most one valve (unique on organization_id, row_id).
-- Used by Pest Planner valve-based targeting and Greenhouse Setup Linked Valves tab.

create table if not exists public.greenhouse_row_valves (
  id             uuid        primary key default gen_random_uuid(),
  organization_id uuid       not null references public.organizations(id),
  valve_id       uuid        not null references public.irrigation_feed_valves(id) on delete cascade,
  row_id         uuid        not null references public.greenhouse_rows(id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (organization_id, row_id)
);

create index if not exists greenhouse_row_valves_org_valve_idx
  on public.greenhouse_row_valves (organization_id, valve_id);

alter table public.greenhouse_row_valves enable row level security;

create policy greenhouse_row_valves_select_org on public.greenhouse_row_valves
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy greenhouse_row_valves_insert_org on public.greenhouse_row_valves
  for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy greenhouse_row_valves_update_org on public.greenhouse_row_valves
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy greenhouse_row_valves_delete_org on public.greenhouse_row_valves
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant all on table public.greenhouse_row_valves to anon, authenticated, service_role;
