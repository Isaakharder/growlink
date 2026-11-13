-- Migration 0156: Dated plantings (DRAFT for review: not applied anywhere)
--
-- A planting is one variety on a set of greenhouse rows from its planting
-- date to its optional pull-out date. It replaces the undated
-- greenhouse_variety_assignments as the record of what grows where and when,
-- so a row can carry this year's crop and next year's crop at once, today's
-- reports see only what is in the ground today, and a past date still finds
-- what was in the ground then.
--
--   plantings       one variety, its planting date and optional pull-out date
--   planting_rows   the rows a planting occupies, by (group, row number), each
--                   with an optional pull-out date of its own (partial pull-out)
--
-- A row's time in the ground runs from the planting's planting date to its
-- effective pull-out date: the earlier of the row's own pull-out date and the
-- planting's, or indefinitely when neither is set. Ending some rows early
-- sets their own pull-out date; the planting and its other rows carry on.
--
-- Rules the database enforces:
--   * A planting's pull-out date is on or after its planting date, and so is
--     each row's own pull-out date.
--   * On any one row, plantings may not overlap in time. Both dates are
--     inclusive, so a row can't be pulled out and replanted on the same day
--     (same-day replanting is not supported unless confirmed). Nothing is
--     ended or replaced automatically: an overlap is refused (23P01) and the
--     person decides what to change.
--   * A planting's variety and rows belong to the planting's organization.
--   * A greenhouse group (phase) with planting history can't be deleted
--     (on delete restrict); the server explains this before trying.
--
-- Rows are identified by greenhouse group and row number, as greenhouse_rows,
-- the Crop Planner (0154) and the map (0155) identify them, so plantings
-- survive rows being regenerated from their sections.
--
-- "Today" is the organization's local date, worked out by the server; the
-- database only answers "what is in the ground on date D" (plantings_on).
--
-- This migration adds tables and functions only. It doesn't read, copy or
-- change greenhouse_variety_assignments; moving First Light's live
-- assignments into plantings is a separate, reviewed step.
--
-- Access: service role only (RLS on, no policies), like 0154 and 0155.

begin;

create table if not exists public.plantings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  variety_id       uuid not null references public.varieties(id) on delete restrict,
  planting_date    date not null,
  pull_out_date    date null,
  notes            text null check (notes is null or length(notes) <= 2000),
  source           text not null default 'planner' check (source in ('planner', 'assignment_import')),
  created_by       uuid null,
  updated_by       uuid null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint plantings_dates_check check (pull_out_date is null or pull_out_date >= planting_date),
  constraint plantings_id_org_key unique (id, organization_id)
);

create index if not exists plantings_org_dates_idx on public.plantings (organization_id, planting_date);

create table if not exists public.planting_rows (
  id               uuid primary key default gen_random_uuid(),
  planting_id      uuid not null,
  organization_id  uuid not null,
  group_id         uuid not null references public.greenhouse_groups(id) on delete restrict,
  row_number       integer not null check (row_number >= 1),
  -- Partial pull-out: this row ends on this date even if the planting runs on.
  pull_out_date    date null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint planting_rows_planting_fkey foreign key (planting_id, organization_id)
    references public.plantings(id, organization_id) on delete cascade,
  constraint planting_rows_planting_row_key unique (planting_id, group_id, row_number)
);

create index if not exists planting_rows_org_row_idx on public.planting_rows (organization_id, group_id, row_number);

-- One writer per organization at a time while overlaps are checked, so two
-- saves can't each pass the check and together overlap.
create or replace function public.plantings_lock_organization(p_organization_id uuid)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtext('plantings:' || p_organization_id::text));
$$;

-- The last day a planting row is in the ground ('infinity' when open-ended).
create or replace function public.planting_row_end(p_row_pull_out date, p_planting_pull_out date)
returns date
language sql
immutable
as $$
  select least(coalesce(p_row_pull_out, 'infinity'::date), coalesce(p_planting_pull_out, 'infinity'::date));
$$;

-- The first row of planting p_planting_id that overlaps another planting's row
-- in time, given p_planting's dates (null when there is none).
create or replace function public.planting_first_clash(
  p_planting_id   uuid,
  p_planting_date date,
  p_pull_out_date date
)
returns table (group_id uuid, row_number integer, other_planting_id uuid)
language sql
stable
set search_path = public
as $$
  select r.group_id, r.row_number, o.id
    from public.planting_rows r
    join public.planting_rows orow
      on orow.organization_id = r.organization_id and orow.group_id = r.group_id and orow.row_number = r.row_number
     and orow.planting_id <> r.planting_id
    join public.plantings o on o.id = orow.planting_id
   where r.planting_id = p_planting_id
     and o.planting_date <= public.planting_row_end(r.pull_out_date, p_pull_out_date)
     and p_planting_date <= public.planting_row_end(orow.pull_out_date, o.pull_out_date)
   limit 1;
$$;

-- A planting's variety belongs to its organization, and new dates don't make
-- any of its rows overlap another planting or end before the planting starts.
create or replace function public.plantings_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clash record;
begin
  if not exists (select 1 from public.varieties v where v.id = new.variety_id and v.organization_id = new.organization_id) then
    raise exception 'A planting''s variety must belong to the planting''s organization' using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and (new.planting_date, new.pull_out_date) is distinct from (old.planting_date, old.pull_out_date) then
    perform public.plantings_lock_organization(new.organization_id);
    if exists (select 1 from public.planting_rows r where r.planting_id = new.id and r.pull_out_date < new.planting_date) then
      raise exception 'Some rows of this planting end before its new planting date' using errcode = 'check_violation';
    end if;
    select * into v_clash from public.planting_first_clash(new.id, new.planting_date, new.pull_out_date);
    if found then
      raise exception 'These dates overlap another planting on a row' using errcode = 'exclusion_violation',
        detail = format('group %s row %s planting %s', v_clash.group_id, v_clash.row_number, v_clash.other_planting_id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists plantings_check on public.plantings;
create trigger plantings_check
  before insert or update on public.plantings
  for each row execute function public.plantings_check();

-- A planting's row is in its organization's greenhouse, doesn't end before
-- the planting starts, and doesn't overlap another planting on the same row.
create or replace function public.planting_rows_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_planting public.plantings%rowtype;
  v_other uuid;
begin
  if not exists (select 1 from public.greenhouse_groups g where g.id = new.group_id and g.organization_id = new.organization_id) then
    raise exception 'A planting row must be in the planting''s organization''s greenhouse' using errcode = 'check_violation';
  end if;

  perform public.plantings_lock_organization(new.organization_id);
  select * into v_planting from public.plantings where id = new.planting_id;
  if new.pull_out_date is not null and new.pull_out_date < v_planting.planting_date then
    raise exception 'A row can''t be pulled out before its planting date' using errcode = 'check_violation';
  end if;

  select o.id into v_other
    from public.planting_rows orow
    join public.plantings o on o.id = orow.planting_id
   where orow.organization_id = new.organization_id and orow.group_id = new.group_id and orow.row_number = new.row_number
     and orow.planting_id <> new.planting_id
     and o.planting_date <= public.planting_row_end(new.pull_out_date, v_planting.pull_out_date)
     and v_planting.planting_date <= public.planting_row_end(orow.pull_out_date, o.pull_out_date)
   limit 1;
  if found then
    raise exception 'This row already has a planting at that time' using errcode = 'exclusion_violation',
      detail = format('group %s row %s planting %s', new.group_id, new.row_number, v_other);
  end if;
  return new;
end;
$$;

drop trigger if exists planting_rows_check on public.planting_rows;
create trigger planting_rows_check
  before insert or update on public.planting_rows
  for each row execute function public.planting_rows_check();

-- Replaces one planting's rows in one transaction (Link rows → Save rows).
-- p_rows: [{"group_id": "...", "row_number": 1}, ...]. Only p_planting_id's
-- rows change: rows it keeps are left alone (with their own pull-out dates),
-- rows not in the list are unlinked, new rows are linked. Any overlap with
-- another planting refuses the whole save; no other planting is touched.
create or replace function public.set_planting_rows(
  p_organization_id uuid,
  p_planting_id     uuid,
  p_rows            jsonb,
  p_user_id         uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  perform public.plantings_lock_organization(p_organization_id);
  if not exists (select 1 from public.plantings where id = p_planting_id and organization_id = p_organization_id) then
    raise exception 'Planting not found' using errcode = 'no_data_found';
  end if;

  delete from public.planting_rows r
   where r.planting_id = p_planting_id
     and not exists (
       select 1 from jsonb_array_elements(p_rows) x
        where (x ->> 'group_id')::uuid = r.group_id and (x ->> 'row_number')::integer = r.row_number
     );

  insert into public.planting_rows (planting_id, organization_id, group_id, row_number)
  select distinct p_planting_id, p_organization_id, (x ->> 'group_id')::uuid, (x ->> 'row_number')::integer
    from jsonb_array_elements(p_rows) x
   where not exists (
     select 1 from public.planting_rows r
      where r.planting_id = p_planting_id and r.group_id = (x ->> 'group_id')::uuid and r.row_number = (x ->> 'row_number')::integer
   );

  update public.plantings set updated_by = p_user_id, updated_at = now() where id = p_planting_id;
  select count(*) into v_count from public.planting_rows where planting_id = p_planting_id;
  return jsonb_build_object('rows', v_count);
end;
$$;

-- Partial pull-out for one planting: sets (or clears, with null) the own
-- pull-out date of the listed rows of p_planting_id only. Overlaps refuse the
-- whole change.
create or replace function public.set_planting_rows_pull_out(
  p_organization_id uuid,
  p_planting_id     uuid,
  p_rows            jsonb,
  p_pull_out_date   date,
  p_user_id         uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  perform public.plantings_lock_organization(p_organization_id);
  if not exists (select 1 from public.plantings where id = p_planting_id and organization_id = p_organization_id) then
    raise exception 'Planting not found' using errcode = 'no_data_found';
  end if;

  update public.planting_rows r
     set pull_out_date = p_pull_out_date, updated_at = now()
   where r.planting_id = p_planting_id
     and exists (
       select 1 from jsonb_array_elements(p_rows) x
        where (x ->> 'group_id')::uuid = r.group_id and (x ->> 'row_number')::integer = r.row_number
     );
  get diagnostics v_count = row_count;

  update public.plantings set updated_by = p_user_id, updated_at = now() where id = p_planting_id;
  return jsonb_build_object('rows', v_count);
end;
$$;

-- What is in the ground on a date: one entry per planted row. This is what
-- live reports read with the organization's local today, and what historical
-- reports read with their own date.
create or replace function public.plantings_on(p_organization_id uuid, p_date date)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'planting_id', p.id, 'variety_id', p.variety_id, 'group_id', r.group_id, 'row_number', r.row_number
         ) order by r.group_id, r.row_number), '[]'::jsonb)
    from public.plantings p
    join public.planting_rows r on r.planting_id = p.id
   where p.organization_id = p_organization_id
     and p.planting_date <= p_date
     and public.planting_row_end(r.pull_out_date, p.pull_out_date) >= p_date;
$$;

revoke all on function public.plantings_lock_organization(uuid) from anon, authenticated, public;
revoke all on function public.planting_row_end(date, date) from anon, authenticated, public;
revoke all on function public.planting_first_clash(uuid, date, date) from anon, authenticated, public;
revoke all on function public.plantings_check() from anon, authenticated, public;
revoke all on function public.planting_rows_check() from anon, authenticated, public;
revoke all on function public.set_planting_rows(uuid, uuid, jsonb, uuid) from anon, authenticated, public;
revoke all on function public.set_planting_rows_pull_out(uuid, uuid, jsonb, date, uuid) from anon, authenticated, public;
revoke all on function public.plantings_on(uuid, date) from anon, authenticated, public;
grant execute on function public.set_planting_rows(uuid, uuid, jsonb, uuid) to service_role;
grant execute on function public.set_planting_rows_pull_out(uuid, uuid, jsonb, date, uuid) to service_role;
grant execute on function public.plantings_on(uuid, date) to service_role;

alter table public.plantings enable row level security;
alter table public.planting_rows enable row level security;

revoke all on table public.plantings, public.planting_rows from anon, authenticated, public;
grant select, insert, update, delete on table public.plantings, public.planting_rows to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['plantings', 'planting_rows'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0156 aborted: row level security is off on public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '0156 aborted: unexpected policy on public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ROLLBACK (drops every dated planting; greenhouse_variety_assignments is unaffected):
-- begin;
-- drop function if exists public.plantings_on(uuid, date);
-- drop function if exists public.set_planting_rows_pull_out(uuid, uuid, jsonb, date, uuid);
-- drop function if exists public.set_planting_rows(uuid, uuid, jsonb, uuid);
-- drop table if exists public.planting_rows, public.plantings;
-- drop function if exists public.planting_rows_check();
-- drop function if exists public.plantings_check();
-- drop function if exists public.planting_first_clash(uuid, date, date);
-- drop function if exists public.planting_row_end(date, date);
-- drop function if exists public.plantings_lock_organization(uuid);
-- commit;
