-- Case history backup / reset / restore — ONE organization at a time.
-- NOT a migration. Run by hand (Supabase SQL editor or psql, as postgres) only
-- when deliberately resetting an organization's case history. See README.md.
--
-- Creates schema case_history_backup (not exposed through the API, no client
-- privileges) holding:
--   backups                      one row per backup: organization, label, row counts, checksums
--   operations                   log of every backup / reset / restore
--   <table> copies               every backed-up row, tagged with its backup_id
-- and three functions:
--   take_backup(org, label)                     -> backup_id
--   reset_case_history(org, backup_id, clear_manual_entries, confirm)
--   restore_case_history(org, backup_id, confirm)
--
-- Backed up (all case- and shipment-related rows of the organization):
--   color_case_entries, manual_pack_case_entries, case_week_sources,
--   case_rebuild_ranges, case_week_confirmations,
--   historical_packs, pack_case_measurements,
--   docklink_pack_weekly_shipments, docklink_packs, docklink_pack_sync_state
-- Cleared by a reset:
--   color_case_entries                              (always)
--   manual_pack_case_entries, case_week_sources,
--   case_rebuild_ranges, case_week_confirmations    (only with clear_manual_entries => true)
-- Never cleared: historical packs, measurements, DockLink's pack data, and
-- every non-case table (harvest yield entries, varieties, …).
--
-- Safe to re-run: everything is create-if-missing / create-or-replace.

begin;

create schema if not exists case_history_backup;
revoke all on schema case_history_backup from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema case_history_backup from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema case_history_backup from authenticated'; end if;
end $$;

create table if not exists case_history_backup.backups (
  backup_id        uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  label            text not null,
  created_at       timestamptz not null default now(),
  created_by       text not null default current_user,
  row_counts       jsonb not null,
  checksums        jsonb not null
);

create table if not exists case_history_backup.operations (
  id               bigserial primary key,
  organization_id  uuid not null,
  operation        text not null check (operation in ('backup', 'reset', 'restore')),
  backup_id        uuid not null,
  detail           jsonb not null default '{}'::jsonb,
  performed_at     timestamptz not null default now(),
  performed_by     text not null default current_user
);

-- Tables in backup order (parents before children, for restore).
create or replace function case_history_backup.backed_up_tables()
returns text[]
language sql
immutable
as $$
  select array[
    'docklink_pack_sync_state', 'docklink_packs', 'docklink_pack_weekly_shipments',
    'historical_packs', 'pack_case_measurements',
    'color_case_entries', 'case_week_sources', 'case_rebuild_ranges', 'case_week_confirmations', 'manual_pack_case_entries'
  ]
$$;

create or replace function case_history_backup.table_exists(p_table text)
returns boolean
language sql
stable
as $$
  select to_regclass(format('public.%I', p_table)) is not null
$$;

-- Order-independent fingerprint of one organization's rows in a table.
create or replace function case_history_backup.live_checksum(p_table text, p_org uuid)
returns text
language plpgsql
stable
as $$
declare
  v text;
begin
  execute format(
    'select md5(coalesce(string_agg(r, ''|'' order by r), '''')) from (select to_jsonb(t)::text r from public.%I t where t.organization_id = $1) x',
    p_table
  ) into v using p_org;
  return v;
end
$$;

create or replace function case_history_backup.backup_checksum(p_table text, p_backup uuid)
returns text
language plpgsql
stable
as $$
declare
  v text;
begin
  execute format(
    'select md5(coalesce(string_agg(r, ''|'' order by r), '''')) from (select (to_jsonb(t) - ''backup_id'')::text r from case_history_backup.%I t where t.backup_id = $1) x',
    p_table
  ) into v using p_backup;
  return v;
end
$$;

create or replace function case_history_backup.take_backup(p_org uuid, p_label text)
returns uuid
language plpgsql
as $$
declare
  v_backup uuid := gen_random_uuid();
  v_table text;
  v_count bigint;
  v_counts jsonb := '{}'::jsonb;
  v_sums jsonb := '{}'::jsonb;
begin
  if p_org is null then raise exception 'organization id is required'; end if;
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'organization % not found', p_org; end if;
  if coalesce(btrim(p_label), '') = '' then raise exception 'a backup label is required'; end if;

  foreach v_table in array case_history_backup.backed_up_tables() loop
    continue when not case_history_backup.table_exists(v_table);
    -- Same columns as the live table (a generated column becomes a plain copy), plus backup_id.
    execute format('create table if not exists case_history_backup.%I (like public.%I)', v_table, v_table);
    execute format('alter table case_history_backup.%I add column if not exists backup_id uuid', v_table);
    execute format('create index if not exists %I on case_history_backup.%I (backup_id)', v_table || '_backup_id_idx', v_table);
    execute format('insert into case_history_backup.%I select t.*, $1 from public.%I t where t.organization_id = $2', v_table, v_table)
      using v_backup, p_org;
    get diagnostics v_count = row_count;
    v_counts := v_counts || jsonb_build_object(v_table, v_count);
    v_sums := v_sums || jsonb_build_object(v_table, case_history_backup.live_checksum(v_table, p_org));
    if case_history_backup.backup_checksum(v_table, v_backup) <> v_sums ->> v_table then
      raise exception 'backup of % does not match the live rows', v_table;
    end if;
  end loop;

  insert into case_history_backup.backups (backup_id, organization_id, label, row_counts, checksums)
  values (v_backup, p_org, btrim(p_label), v_counts, v_sums);
  insert into case_history_backup.operations (organization_id, operation, backup_id, detail)
  values (p_org, 'backup', v_backup, jsonb_build_object('label', btrim(p_label), 'row_counts', v_counts));
  return v_backup;
end
$$;

create or replace function case_history_backup.cleared_tables(p_clear_manual boolean)
returns text[]
language sql
immutable
as $$
  select case when p_clear_manual
    then array['color_case_entries', 'manual_pack_case_entries', 'case_week_sources', 'case_rebuild_ranges', 'case_week_confirmations']
    else array['color_case_entries'] end
$$;

-- Deletes the organization's case history. Refuses unless:
--   * p_confirm is exactly 'RESET <organization id>';
--   * the backup belongs to this organization; and
--   * every table to be cleared still matches that backup exactly
--     (nothing written since — otherwise take a fresh backup first).
create or replace function case_history_backup.reset_case_history(p_org uuid, p_backup uuid, p_clear_manual_entries boolean, p_confirm text)
returns jsonb
language plpgsql
as $$
declare
  v_backup case_history_backup.backups%rowtype;
  v_table text;
  v_count bigint;
  v_deleted jsonb := '{}'::jsonb;
begin
  if p_confirm is distinct from 'RESET ' || p_org::text then
    raise exception 'confirmation text must be exactly: RESET %', p_org;
  end if;
  select * into v_backup from case_history_backup.backups where backup_id = p_backup;
  if not found or v_backup.organization_id <> p_org then raise exception 'backup % not found for organization %', p_backup, p_org; end if;

  foreach v_table in array case_history_backup.cleared_tables(p_clear_manual_entries) loop
    continue when not case_history_backup.table_exists(v_table);
    -- Block concurrent writes between the check and the delete.
    execute format('lock table public.%I in share row exclusive mode', v_table);
    if case_history_backup.live_checksum(v_table, p_org) is distinct from v_backup.checksums ->> v_table then
      raise exception '% changed after backup % was taken; take a new backup and use it', v_table, p_backup;
    end if;
  end loop;

  -- A fixed order; no table depends on these.
  foreach v_table in array array['manual_pack_case_entries', 'case_week_sources', 'case_rebuild_ranges', 'case_week_confirmations', 'color_case_entries'] loop
    continue when not (v_table = any (case_history_backup.cleared_tables(p_clear_manual_entries))) or not case_history_backup.table_exists(v_table);
    execute format('delete from public.%I where organization_id = $1', v_table) using p_org;
    get diagnostics v_count = row_count;
    v_deleted := v_deleted || jsonb_build_object(v_table, v_count);
  end loop;

  insert into case_history_backup.operations (organization_id, operation, backup_id, detail)
  values (p_org, 'reset', p_backup, jsonb_build_object('deleted', v_deleted, 'clear_manual_entries', p_clear_manual_entries));
  return jsonb_build_object('backup_id', p_backup, 'deleted', v_deleted);
end
$$;

-- Puts the organization's rows of every table a reset clears back exactly as
-- they were in the backup (same ids and values). Rows written after the
-- backup (e.g. colour totals re-synced, entries re-entered) are replaced, so
-- they are first saved in a new 'pre-restore' backup. Verified by checksum;
-- any mismatch or constraint failure rolls everything back.
create or replace function case_history_backup.restore_case_history(p_org uuid, p_backup uuid, p_confirm text)
returns jsonb
language plpgsql
as $$
declare
  v_backup case_history_backup.backups%rowtype;
  v_safety uuid;
  v_table text;
  v_cols text;
  v_count bigint;
  v_restored jsonb := '{}'::jsonb;
  v_tables text[] := array['color_case_entries', 'case_week_sources', 'case_rebuild_ranges', 'case_week_confirmations', 'manual_pack_case_entries'];
begin
  if p_confirm is distinct from 'RESTORE ' || p_org::text then
    raise exception 'confirmation text must be exactly: RESTORE %', p_org;
  end if;
  select * into v_backup from case_history_backup.backups where backup_id = p_backup;
  if not found or v_backup.organization_id <> p_org then raise exception 'backup % not found for organization %', p_backup, p_org; end if;

  v_safety := case_history_backup.take_backup(p_org, 'pre-restore of ' || p_backup::text);

  foreach v_table in array array['manual_pack_case_entries', 'case_week_sources', 'case_rebuild_ranges', 'case_week_confirmations', 'color_case_entries'] loop
    continue when not case_history_backup.table_exists(v_table) or not (v_backup.row_counts ? v_table);
    execute format('delete from public.%I where organization_id = $1', v_table) using p_org;
  end loop;

  foreach v_table in array v_tables loop
    continue when not case_history_backup.table_exists(v_table) or not (v_backup.row_counts ? v_table);
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position) into v_cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = v_table and c.is_generated = 'NEVER';
    execute format('insert into public.%I (%s) select %s from case_history_backup.%I where backup_id = $1', v_table, v_cols, v_cols, v_table)
      using p_backup;
    get diagnostics v_count = row_count;
    v_restored := v_restored || jsonb_build_object(v_table, v_count);
    if case_history_backup.live_checksum(v_table, p_org) is distinct from v_backup.checksums ->> v_table then
      raise exception 'restored % does not match backup %', v_table, p_backup;
    end if;
  end loop;

  insert into case_history_backup.operations (organization_id, operation, backup_id, detail)
  values (p_org, 'restore', p_backup, jsonb_build_object('restored', v_restored, 'pre_restore_backup_id', v_safety));
  return jsonb_build_object('backup_id', p_backup, 'restored', v_restored, 'pre_restore_backup_id', v_safety);
end
$$;

revoke all on all tables in schema case_history_backup from public;
revoke all on all functions in schema case_history_backup from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema case_history_backup from anon';
    execute 'revoke all on all functions in schema case_history_backup from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema case_history_backup from authenticated';
    execute 'revoke all on all functions in schema case_history_backup from authenticated';
  end if;
end $$;

commit;
