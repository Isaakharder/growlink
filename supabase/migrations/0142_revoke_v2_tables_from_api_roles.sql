-- Migration 0142: The three server-only tables created by 0141
-- (integration_deletions, integration_manifests, yield_entry_revisions)
-- received this project's default grants for anon/authenticated. RLS with no
-- policies already blocks every row for those roles, but TRUNCATE (and
-- REFERENCES/TRIGGER) are not governed by RLS. Same treatment as 0140:
-- revoke everything from anon, authenticated and PUBLIC; service_role keeps
-- SELECT/INSERT/UPDATE/DELETE (the Express server and the 0141 triggers use
-- them); assert the end state or roll back.

begin;

revoke all on table public.integration_deletions  from anon, authenticated, public;
revoke all on table public.integration_manifests  from anon, authenticated, public;
revoke all on table public.yield_entry_revisions  from anon, authenticated, public;

grant select, insert, update, delete on table public.integration_deletions to service_role;
grant select, insert, update, delete on table public.integration_manifests to service_role;
grant select, insert, update, delete on table public.yield_entry_revisions to service_role;
grant usage, select on sequence public.yield_entry_revisions_id_seq to service_role;

do $$
declare
  t text;
  r text;
  p text;
begin
  foreach t in array array['integration_deletions', 'integration_manifests', 'yield_entry_revisions'] loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, format('public.%I', t), p) then
          raise exception '0142 aborted: % still has % on public.%', r, p, t;
        end if;
      end loop;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', t), p) then
        raise exception '0142 aborted: service_role lacks % on public.%', p, t;
      end if;
    end loop;
    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      raise exception '0142 aborted: row level security is off on public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '0142 aborted: unexpected policy on public.%', t;
    end if;
  end loop;
end $$;

commit;

-- ROLLBACK (restores the post-0141 default grants; not needed for any workflow):
-- begin;
-- grant references, trigger, truncate on table public.integration_deletions, public.integration_manifests, public.yield_entry_revisions to anon, authenticated;
-- commit;
