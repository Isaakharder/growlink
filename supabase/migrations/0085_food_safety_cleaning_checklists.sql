-- Food Safety mobile cleaning checklists.
--
-- A location can have tasks on different frequencies (daily/weekly/monthly/
-- annually). Rather than one checklist per location, this models one
-- checklist per (location, frequency, period instance) — e.g. a location
-- with 4 daily tasks and 1 weekly task gets a separate 'daily' checklist
-- (reset every day) and a separate 'weekly' checklist (reset every ISO
-- week). The mobile page combines every currently-relevant checklist for a
-- location into a single card; a location reads as "complete" once all of
-- its currently-relevant checklists are complete.
--
-- period_key is computed server-side (never trusted from the client) using
-- a single fixed timezone for now (see server/src/config/orgTimezone.ts),
-- so every employee sees the same checklist regardless of device clock/tz.
--
-- Employee identity for who checked/completed a task is resolved from the
-- authenticated Supabase session server-side (never client-supplied) — see
-- server/src/routes/foodSafety/services/actorIdentity.ts. There is
-- deliberately no employee_id column yet: GrowLink users are not yet linked
-- to `employees` rows, so completion is attributed directly to the
-- authenticated user (user_id + a name/initials snapshot), consistent with
-- the rest of this migration's "snapshot" pattern for historical accuracy.

create table if not exists public.food_safety_cleaning_checklists (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        not null references public.organizations(id) on delete cascade,
  location_id            uuid        not null references public.food_safety_cleaning_locations(id) on delete cascade,
  period_type            text        not null check (period_type in ('daily', 'weekly', 'monthly', 'annually')),
  period_key             text        not null,
  status                 text        not null default 'incomplete' check (status in ('incomplete', 'complete')),
  completed_at           timestamptz,
  completed_by_user_id   uuid        references auth.users(id) on delete set null,
  completed_by_name      text,
  completed_by_initials  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint food_safety_cleaning_checklists_location_period_key
    unique (location_id, period_type, period_key)
);

create index if not exists food_safety_cleaning_checklists_org_idx
  on public.food_safety_cleaning_checklists (organization_id);

create index if not exists food_safety_cleaning_checklists_location_idx
  on public.food_safety_cleaning_checklists (location_id, period_type, period_key);

alter table public.food_safety_cleaning_checklists enable row level security;

drop policy if exists food_safety_cleaning_checklists_select_org on public.food_safety_cleaning_checklists;
create policy food_safety_cleaning_checklists_select_org on public.food_safety_cleaning_checklists
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_checklists_insert_org on public.food_safety_cleaning_checklists;
create policy food_safety_cleaning_checklists_insert_org on public.food_safety_cleaning_checklists
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_checklists_update_org on public.food_safety_cleaning_checklists;
create policy food_safety_cleaning_checklists_update_org on public.food_safety_cleaning_checklists
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_cleaning_checklists to service_role;


create table if not exists public.food_safety_cleaning_checklist_items (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        not null references public.organizations(id) on delete cascade,
  checklist_id          uuid        not null references public.food_safety_cleaning_checklists(id) on delete cascade,
  -- Nullable + SET NULL: a task edited/removed on the desktop later must
  -- never delete historical/completed checklist items — task_name_snapshot
  -- and frequency_snapshot already make this row self-contained.
  task_id               uuid        references public.food_safety_cleaning_tasks(id) on delete set null,
  task_name_snapshot    text        not null,
  frequency_snapshot    text        not null check (frequency_snapshot in ('daily', 'weekly', 'monthly', 'annually')),
  is_complete           boolean     not null default false,
  -- checked_at/checked_by_* reflect the most recent check OR uncheck action
  -- (whichever happened last), not exclusively "who completed it" — this is
  -- what makes the required "who unchecked it and when" audit trail work
  -- with a single set of columns instead of a separate event log.
  checked_at            timestamptz,
  checked_by_user_id    uuid        references auth.users(id) on delete set null,
  checked_by_name       text,
  checked_by_initials   text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint food_safety_cleaning_checklist_items_checklist_task_key
    unique (checklist_id, task_id)
);

create index if not exists food_safety_cleaning_checklist_items_org_idx
  on public.food_safety_cleaning_checklist_items (organization_id);

create index if not exists food_safety_cleaning_checklist_items_checklist_idx
  on public.food_safety_cleaning_checklist_items (checklist_id);

alter table public.food_safety_cleaning_checklist_items enable row level security;

drop policy if exists food_safety_cleaning_checklist_items_select_org on public.food_safety_cleaning_checklist_items;
create policy food_safety_cleaning_checklist_items_select_org on public.food_safety_cleaning_checklist_items
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_checklist_items_insert_org on public.food_safety_cleaning_checklist_items;
create policy food_safety_cleaning_checklist_items_insert_org on public.food_safety_cleaning_checklist_items
  for insert to authenticated
  with check (public.is_org_member(organization_id));

drop policy if exists food_safety_cleaning_checklist_items_update_org on public.food_safety_cleaning_checklist_items;
create policy food_safety_cleaning_checklist_items_update_org on public.food_safety_cleaning_checklist_items
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.food_safety_cleaning_checklist_items to service_role;


-- Atomically fetches (or creates, with its items) the checklist for a given
-- location + frequency-period. p_period_type/p_period_key are computed
-- server-side (see checklistPeriod.ts) and trusted as-is here — this
-- function only needs to be safe against concurrent callers, not against a
-- malicious period_key, since nothing outside the Express layer can invoke
-- it (service-role only).
create or replace function public.food_safety_get_or_create_checklist(
  p_organization_id uuid,
  p_location_id uuid,
  p_period_type text,
  p_period_key text
)
returns uuid
language plpgsql
as $$
declare
  v_checklist_id uuid;
  v_item_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_location_id::text || ':' || p_period_type || ':' || p_period_key, 3));

  select id into v_checklist_id
  from public.food_safety_cleaning_checklists
  where location_id = p_location_id and period_type = p_period_type and period_key = p_period_key;

  if v_checklist_id is not null then
    return v_checklist_id;
  end if;

  insert into public.food_safety_cleaning_checklists (
    organization_id, location_id, period_type, period_key, status
  ) values (
    p_organization_id, p_location_id, p_period_type, p_period_key, 'incomplete'
  )
  returning id into v_checklist_id;

  insert into public.food_safety_cleaning_checklist_items (
    checklist_id, organization_id, task_id, task_name_snapshot, frequency_snapshot, is_complete
  )
  select v_checklist_id, p_organization_id, t.id, t.name, t.frequency, false
  from public.food_safety_cleaning_tasks t
  where t.location_id = p_location_id and t.frequency = p_period_type;

  get diagnostics v_item_count = row_count;

  -- No tasks of this frequency currently exist at the location (e.g. the
  -- last one was just removed on the desktop) — vacuously complete, no
  -- employee to credit.
  if v_item_count = 0 then
    update public.food_safety_cleaning_checklists
    set status = 'complete', completed_at = now()
    where id = v_checklist_id;
  end if;

  return v_checklist_id;
end;
$$;

grant execute on function public.food_safety_get_or_create_checklist(uuid, uuid, text, text) to service_role;


-- Atomically checks/unchecks a single item and, if that was the last item
-- outstanding, finalizes the parent checklist — all under one advisory +
-- row lock so two phones acting on the same checklist at once can never
-- both "win" the finalization or race past the outstanding-items count.
create or replace function public.food_safety_set_checklist_item_status(
  p_organization_id uuid,
  p_item_id uuid,
  p_is_complete boolean,
  p_actor_user_id uuid,
  p_actor_name text,
  p_actor_initials text
)
returns public.food_safety_cleaning_checklists
language plpgsql
as $$
declare
  v_checklist_id uuid;
  v_checklist public.food_safety_cleaning_checklists;
  v_now timestamptz := now();
  v_remaining integer;
begin
  select checklist_id into v_checklist_id
  from public.food_safety_cleaning_checklist_items
  where id = p_item_id and organization_id = p_organization_id;

  if v_checklist_id is null then
    raise exception 'Checklist item % not found in organization %', p_item_id, p_organization_id using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_checklist_id::text, 4));

  select * into v_checklist
  from public.food_safety_cleaning_checklists
  where id = v_checklist_id
  for update;

  if v_checklist.status = 'complete' and not p_is_complete then
    raise exception 'This cleaning checklist has already been finalized and cannot be changed.'
      using errcode = '42501';
  end if;

  update public.food_safety_cleaning_checklist_items
  set is_complete = p_is_complete,
      checked_at = v_now,
      checked_by_user_id = p_actor_user_id,
      checked_by_name = p_actor_name,
      checked_by_initials = p_actor_initials,
      updated_at = v_now
  where id = p_item_id;

  select count(*) into v_remaining
  from public.food_safety_cleaning_checklist_items
  where checklist_id = v_checklist_id and is_complete = false;

  if v_remaining = 0 and v_checklist.status <> 'complete' then
    update public.food_safety_cleaning_checklists
    set status = 'complete',
        completed_at = v_now,
        completed_by_user_id = p_actor_user_id,
        completed_by_name = p_actor_name,
        completed_by_initials = p_actor_initials,
        updated_at = v_now
    where id = v_checklist_id
    returning * into v_checklist;
  end if;

  return v_checklist;
end;
$$;

grant execute on function public.food_safety_set_checklist_item_status(uuid, uuid, boolean, uuid, text, text) to service_role;
