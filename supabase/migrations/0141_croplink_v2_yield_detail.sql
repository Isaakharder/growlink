-- CropLink integration v2: scoped keys, write provenance, settlement, deletion
-- tombstones, immutable id manifests, and an audit trail for edits (including
-- late edits to already-settled weeks).
--
-- Settlement mirrors server/src/lib/croplinkV2.ts computeSettlement(): a
-- packing week is settled once it ended 10+ days ago (end of Sunday,
-- America/Toronto) AND the entry has been unchanged for 3+ days. Any change
-- to the entry or its daily breakdown bumps yield_entries.updated_at, so a
-- settled week reverts to provisional automatically.

-- ── Scoped integration keys ─────────────────────────────────────────────────
alter table public.organization_integration_keys
  add column if not exists scopes text[] not null default '{harvest-actuals:read}';

alter table public.organization_integration_keys
  drop constraint if exists organization_integration_keys_scopes_check;
alter table public.organization_integration_keys
  add constraint organization_integration_keys_scopes_check
  check (cardinality(scopes) > 0 and scopes <@ array['harvest-actuals:read', 'yield-detail:read']::text[]);

-- ── Write provenance ────────────────────────────────────────────────────────
alter table public.yield_entries
  add column if not exists last_write_source text not null default 'unknown';
alter table public.yield_entries
  drop constraint if exists yield_entries_last_write_source_check;
alter table public.yield_entries
  add constraint yield_entries_last_write_source_check
  check (last_write_source in ('manual_create', 'manual_merge', 'manual_edit', 'import_pdf', 'import_csv', 'unknown'));

-- Keyset pagination for v2 (organization_id, updated_at, id).
create index if not exists yield_entries_org_updated_id_idx
  on public.yield_entries (organization_id, updated_at, id);

-- ── Settlement helpers ──────────────────────────────────────────────────────
create or replace function public.iso_week_end_local(p_year integer, p_week integer, p_tz text)
returns timestamptz
language sql
immutable
strict
as $$
  select ((to_date(p_year::text || '-' || lpad(p_week::text, 2, '0') || '-1', 'IYYY-IW-ID') + 7)::timestamp
          at time zone p_tz)
$$;

create or replace function public.yield_week_is_settled(p_year integer, p_week integer, p_last_changed timestamptz, p_at timestamptz)
returns boolean
language sql
stable
strict
as $$
  select p_at >= public.iso_week_end_local(p_year, p_week, 'America/Toronto') + interval '10 days'
     and p_last_changed <= p_at - interval '3 days'
$$;

-- ── Deletion tombstones ─────────────────────────────────────────────────────
create table if not exists public.integration_deletions (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  entity          text        not null check (entity in ('yield_entry')),
  entity_id       uuid        not null,
  variety_id      uuid,
  year            integer,
  week            integer,
  deleted_at      timestamptz not null default clock_timestamp()
);
create index if not exists integration_deletions_org_deleted_idx
  on public.integration_deletions (organization_id, entity, deleted_at, id);
alter table public.integration_deletions enable row level security;

-- ── Immutable id manifests for complete-set reconciliation ──────────────────
create table if not exists public.integration_manifests (
  id              uuid        primary key,
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  entity          text        not null check (entity in ('yield_entry')),
  entity_ids      uuid[]      not null,
  expected_count  integer     not null check (expected_count = cardinality(entity_ids)),
  checksum        text        not null,
  algorithm       text        not null,
  created_at      timestamptz not null,
  expires_at      timestamptz not null
);
create index if not exists integration_manifests_org_idx on public.integration_manifests (organization_id, created_at);
alter table public.integration_manifests enable row level security;

-- ── Edit audit (late edits to settled weeks are flagged) ────────────────────
create table if not exists public.yield_entry_revisions (
  id                bigserial   primary key,
  organization_id   uuid        not null,
  yield_entry_id    uuid        not null,
  change_kind       text        not null check (change_kind in ('update', 'daily_breakdown', 'delete')),
  was_settled       boolean     not null,
  packing_year      integer     not null,
  packing_week      integer     not null,
  last_write_source text,
  previous          jsonb,
  current           jsonb,
  changed_at        timestamptz not null default clock_timestamp()
);
create index if not exists yield_entry_revisions_entry_idx on public.yield_entry_revisions (yield_entry_id, changed_at);
create index if not exists yield_entry_revisions_late_idx on public.yield_entry_revisions (organization_id, changed_at) where was_settled;
alter table public.yield_entry_revisions enable row level security;

create or replace function public.yield_entry_tracked(r public.yield_entries)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'variety_id', r.variety_id, 'year', r.year, 'week', r.week, 'packed_date', r.packed_date,
    'size_kg', r.size_kg, 'total_kg', r.total_kg, 'average_fruit_weight_g', r.average_fruit_weight_g,
    'kg_per_m2', r.kg_per_m2, 'total_cases', r.total_cases)
$$;

create or replace function public.yield_entries_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if public.yield_entry_tracked(old) is distinct from public.yield_entry_tracked(new) then
      insert into public.yield_entry_revisions
        (organization_id, yield_entry_id, change_kind, was_settled, packing_year, packing_week, last_write_source, previous, current)
      values
        (new.organization_id, new.id, 'update', public.yield_week_is_settled(old.year, old.week, old.updated_at, now()),
         old.year, old.week, new.last_write_source, public.yield_entry_tracked(old), public.yield_entry_tracked(new));
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.integration_deletions (organization_id, entity, entity_id, variety_id, year, week)
    values (old.organization_id, 'yield_entry', old.id, old.variety_id, old.year, old.week);
    insert into public.yield_entry_revisions
      (organization_id, yield_entry_id, change_kind, was_settled, packing_year, packing_week, last_write_source, previous, current)
    values
      (old.organization_id, old.id, 'delete', public.yield_week_is_settled(old.year, old.week, old.updated_at, now()),
       old.year, old.week, old.last_write_source, public.yield_entry_tracked(old), null);
    return old;
  end if;
  return null;
end
$$;

drop trigger if exists yield_entries_audit_trg on public.yield_entries;
create trigger yield_entries_audit_trg
  after update or delete on public.yield_entries
  for each row execute function public.yield_entries_audit();

-- Daily breakdown changes are source-data changes too: audit them and bump
-- the parent's updated_at so its settlement reverts to provisional.
create or replace function public.yield_entry_daily_breakdown_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent public.yield_entries;
begin
  select * into parent from public.yield_entries
   where id = coalesce(new.yield_entry_id, old.yield_entry_id);
  if not found then
    return null; -- parent already deleted (cascade); its own delete was audited
  end if;
  insert into public.yield_entry_revisions
    (organization_id, yield_entry_id, change_kind, was_settled, packing_year, packing_week, last_write_source, previous, current)
  values
    (parent.organization_id, parent.id, 'daily_breakdown', public.yield_week_is_settled(parent.year, parent.week, parent.updated_at, now()),
     parent.year, parent.week, parent.last_write_source,
     case when tg_op = 'INSERT' then null else to_jsonb(old) end,
     case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  update public.yield_entries set updated_at = clock_timestamp() where id = parent.id;
  return null;
end
$$;

drop trigger if exists yield_entry_daily_breakdown_audit_trg on public.yield_entry_daily_breakdown;
create trigger yield_entry_daily_breakdown_audit_trg
  after insert or update or delete on public.yield_entry_daily_breakdown
  for each row execute function public.yield_entry_daily_breakdown_audit();
