-- H1 Food Safety spray/drench application log table.
-- One row is created automatically when a spray or drench job is completed.
create table if not exists public.food_safety_h1_logs (
  id                            uuid        primary key default gen_random_uuid(),
  organization_id               uuid        not null references public.organizations(id),
  pest_job_id                   uuid        references public.pest_control_todos(id) on delete set null,
  application_date              date        not null,
  product_name                  text        not null,
  pcp_number                    text,
  actual_quantity_used          numeric,
  actual_quantity_unit          text,
  rate_applied_per_unit         text,
  label_instructions_followed   boolean     not null default true,
  area_quantity_treated_m2      numeric,
  method_of_application         text,
  row_house_zones               text,
  earliest_allowable_harvest_date date,
  phi_daa                       integer,
  applicator_name               text,
  created_at                    timestamptz not null default now()
);

create index if not exists food_safety_h1_logs_organization_id_idx
  on public.food_safety_h1_logs (organization_id);

create index if not exists food_safety_h1_logs_pest_job_id_idx
  on public.food_safety_h1_logs (pest_job_id);

alter table public.food_safety_h1_logs enable row level security;

create policy h1_logs_select_org on public.food_safety_h1_logs
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy h1_logs_insert_org on public.food_safety_h1_logs
  for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy h1_logs_update_org on public.food_safety_h1_logs
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy h1_logs_delete_org on public.food_safety_h1_logs
  for delete to authenticated
  using (public.is_org_member(organization_id));

grant all on table public.food_safety_h1_logs to anon, authenticated, service_role;
