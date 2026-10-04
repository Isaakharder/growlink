-- Migration 0140: Lock down public.organization_integration_keys and
-- public.organization_upload_keys to the server (service role) only.
--
-- Live state before this migration (production preflight, 2026-10-04):
--   organization_integration_keys: four policies from 0072 —
--     organization_integration_keys_{select,insert,update,delete} — `to public`
--     with using/with check (true). RLS enabled.
--   organization_upload_keys: RLS enabled, no policies.
--   Both tables: anon and authenticated hold only REFERENCES, TRIGGER and
--     TRUNCATE (no SELECT/INSERT/UPDATE/DELETE, so the open policies were not
--     reachable through the API); service_role holds full privileges.
--
-- Both tables are server-only: the web and iOS clients never query them and no
-- database function or view references them. The Express server uses the
-- service role (select/insert/update/delete: key lookup, last_used_at, admin
-- create/revoke/delete).
--
-- This migration:
--   1. drops the four wide-open integration-key policies by exact name;
--   2. revokes every table privilege from anon, authenticated and PUBLIC on
--      both tables (incl. TRUNCATE, TRIGGER, REFERENCES); grants nothing back;
--   3. (re)grants service_role exactly SELECT, INSERT, UPDATE, DELETE on both;
--   4. keeps RLS enabled on both;
--   5. aborts — rolling everything back — unless that end state holds.
--
-- Rollback to the pre-migration state: see the end of this file.

begin;

drop policy if exists organization_integration_keys_select on public.organization_integration_keys;
drop policy if exists organization_integration_keys_insert on public.organization_integration_keys;
drop policy if exists organization_integration_keys_update on public.organization_integration_keys;
drop policy if exists organization_integration_keys_delete on public.organization_integration_keys;

revoke all on table public.organization_integration_keys from anon, authenticated, public;
revoke all on table public.organization_upload_keys      from anon, authenticated, public;

grant select, insert, update, delete on table public.organization_integration_keys to service_role;
grant select, insert, update, delete on table public.organization_upload_keys      to service_role;

alter table public.organization_integration_keys enable row level security;
alter table public.organization_upload_keys      enable row level security;

do $$
declare
  t text;
  r text;
  p text;
  leftover text;
begin
  -- No policy of any kind remains on either table (server-only tables need none).
  select string_agg(tablename || '.' || policyname, ', ') into leftover
  from pg_policies
  where schemaname = 'public' and tablename in ('organization_integration_keys', 'organization_upload_keys');
  if leftover is not null then
    raise exception '0140 aborted: policies remain: %', leftover;
  end if;

  foreach t in array array['organization_integration_keys', 'organization_upload_keys'] loop
    -- anon / authenticated: no table privilege at all, including via PUBLIC.
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, format('public.%I', t), p) then
          raise exception '0140 aborted: % still has % on public.%', r, p, t;
        end if;
      end loop;
      if has_any_column_privilege(r, format('public.%I', t), 'SELECT, INSERT, UPDATE, REFERENCES') then
        raise exception '0140 aborted: % still has a column privilege on public.%', r, t;
      end if;
    end loop;

    -- service_role keeps exactly what the server uses.
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', t), p) then
        raise exception '0140 aborted: service_role lacks % on public.%', p, t;
      end if;
    end loop;

    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      raise exception '0140 aborted: row level security is off on public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ROLLBACK (restores the exact pre-migration state recorded above; run only if
-- the server can no longer read or write keys). Kept commented out on purpose.
--
-- begin;
-- create policy organization_integration_keys_select on public.organization_integration_keys for select to public using (true);
-- create policy organization_integration_keys_insert on public.organization_integration_keys for insert to public with check (true);
-- create policy organization_integration_keys_update on public.organization_integration_keys for update to public using (true) with check (true);
-- create policy organization_integration_keys_delete on public.organization_integration_keys for delete to public using (true);
-- grant references, trigger, truncate on table public.organization_integration_keys to anon, authenticated;
-- grant references, trigger, truncate on table public.organization_upload_keys      to anon, authenticated;
-- commit;
