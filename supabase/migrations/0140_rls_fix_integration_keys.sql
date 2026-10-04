-- Migration 0140: Close anonymous / cross-tenant access to
-- public.organization_integration_keys.
--
-- Evidence (migration 0072): four policies `to public` with `using (true)` /
-- `with check (true)` for SELECT, INSERT, UPDATE and DELETE. Combined with the
-- default table grants Supabase gives anon and authenticated, any caller holding
-- the public anon key could read every organization's key hashes and labels,
-- revoke keys, or INSERT a key row (with a hash of a value they chose) for any
-- organization — i.e. mint a working CropLink integration key.
--
-- The table is server-only: the web and iOS clients never query it, and the
-- Express server uses the service role (which bypasses RLS and keeps its
-- explicit grant from 0072). Apply BEFORE 0141 (which adds key scopes).
--
-- Policies are dropped by exact name. Nothing else is touched.

begin;

drop policy if exists organization_integration_keys_select on public.organization_integration_keys;
drop policy if exists organization_integration_keys_insert on public.organization_integration_keys;
drop policy if exists organization_integration_keys_update on public.organization_integration_keys;
drop policy if exists organization_integration_keys_delete on public.organization_integration_keys;

revoke all on table public.organization_integration_keys from anon, authenticated;

alter table public.organization_integration_keys enable row level security;

do $$
declare
  leftover text;
  r text;
  p text;
begin
  select string_agg(policyname, ', ') into leftover
  from pg_policies
  where schemaname = 'public' and tablename = 'organization_integration_keys';
  if leftover is not null then
    raise exception 'integration key fix aborted: policies remain: %', leftover;
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(r, 'public.organization_integration_keys', p) then
        raise exception 'integration key fix aborted: % still has % on organization_integration_keys', r, p;
      end if;
    end loop;
    if has_any_column_privilege(r, 'public.organization_integration_keys', 'SELECT, INSERT, UPDATE, REFERENCES') then
      raise exception 'integration key fix aborted: % still has a column privilege', r;
    end if;
  end loop;

  if not has_table_privilege('service_role', 'public.organization_integration_keys', 'SELECT')
     or not has_table_privilege('service_role', 'public.organization_integration_keys', 'INSERT')
     or not has_table_privilege('service_role', 'public.organization_integration_keys', 'UPDATE') then
    raise exception 'integration key fix aborted: service_role lost its access';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.organization_integration_keys'::regclass) then
    raise exception 'integration key fix aborted: row level security is off';
  end if;
end $$;

commit;
