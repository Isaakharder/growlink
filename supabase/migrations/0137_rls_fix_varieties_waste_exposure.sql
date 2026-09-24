-- Migration 0137: Close confirmed anonymous / cross-tenant exposure on
-- public.varieties, public.waste_imports and public.waste_variety_mappings.
--
-- Evidence (live pg_policies + privilege audit):
--   varieties: four legacy policies `to public using/with check (true)`
--     ("Allow read|insert|update|delete varieties", created outside the migrations)
--     combined with SELECT/INSERT/UPDATE/DELETE held by anon AND authenticated meant
--     any anonymous caller, and any logged-in user of ANY organization, could read,
--     insert, update and delete every organization's varieties. The intended gated
--     policies (varieties_*_org, using is_org_member()) already exist and are kept.
--   waste_imports, waste_variety_mappings: `*_all` policies `to public using/with
--     check (true)` (migration 0050) plus full DML grants to anon and authenticated.
--     Both tables are server-only (Express + service role).
--
-- The web and iOS clients never query these tables through PostgREST (they query only
-- memberships and organizations), and the Express server uses the service role, which
-- bypasses RLS and is not affected by any change below.
--
-- Every policy is dropped by exact name. Nothing is removed by pattern or by expression
-- text. memberships / organizations policies and grants are not touched. The quality_*
-- anon "tv_read_first_light" policies are intentionally left unchanged (separate follow-up).

begin;

-- ============================================================
-- 1. Remove the wide-open policies (exact names)
-- ============================================================
drop policy if exists "Allow read varieties"   on public.varieties;
drop policy if exists "Allow insert varieties" on public.varieties;
drop policy if exists "Allow update varieties" on public.varieties;
drop policy if exists "Allow delete varieties" on public.varieties;

drop policy if exists waste_imports_select_all          on public.waste_imports;
drop policy if exists waste_imports_insert_all          on public.waste_imports;
drop policy if exists waste_imports_update_all          on public.waste_imports;
drop policy if exists waste_imports_delete_all          on public.waste_imports;
drop policy if exists waste_variety_mappings_select_all on public.waste_variety_mappings;
drop policy if exists waste_variety_mappings_insert_all on public.waste_variety_mappings;
drop policy if exists waste_variety_mappings_update_all on public.waste_variety_mappings;
drop policy if exists waste_variety_mappings_delete_all on public.waste_variety_mappings;

-- ============================================================
-- 2. Privileges
--    varieties: anon gets nothing. authenticated keeps only SELECT/INSERT/UPDATE/DELETE
--    (governed by the existing varieties_*_org policies); the whole-table privileges that
--    bypass or sidestep row-level security (TRUNCATE, REFERENCES, TRIGGER) are removed.
--    waste_*: server-only, so neither anon nor authenticated needs any privilege.
-- ============================================================
revoke all on table public.varieties from anon;
revoke truncate, references, trigger on table public.varieties from authenticated;

revoke all on table public.waste_imports          from anon, authenticated;
revoke all on table public.waste_variety_mappings from anon, authenticated;

-- ============================================================
-- 3. Assertions: abort (roll back everything above) unless the intended end state holds
-- ============================================================
do $$
declare
  leftover text;
  t text;
  p text;
begin
  -- 3a. no policy remains that applies to PUBLIC or anon on these tables
  select string_agg(tablename || '.' || policyname, ', ')
    into leftover
  from pg_policies
  where schemaname = 'public'
    and tablename in ('varieties', 'waste_imports', 'waste_variety_mappings')
    and roles && array['public', 'anon']::name[];
  if leftover is not null then
    raise exception 'RLS fix aborted: public/anon policies remain: %', leftover;
  end if;

  -- 3b. anon holds no privilege of any kind (table-level, column-level or via PUBLIC)
  foreach t in array array['varieties', 'waste_imports', 'waste_variety_mappings'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', format('public.%I', t), p) then
        raise exception 'RLS fix aborted: anon still has % on public.%', p, t;
      end if;
    end loop;
    if has_any_column_privilege('anon', format('public.%I', t), 'SELECT, INSERT, UPDATE, REFERENCES') then
      raise exception 'RLS fix aborted: anon still has a column privilege on public.%', t;
    end if;
  end loop;

  -- 3c. authenticated: nothing on waste_*, and on varieties no privilege that sidesteps RLS
  foreach t in array array['waste_imports', 'waste_variety_mappings'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('authenticated', format('public.%I', t), p) then
        raise exception 'RLS fix aborted: authenticated still has % on public.%', p, t;
      end if;
    end loop;
  end loop;
  foreach p in array array['TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if has_table_privilege('authenticated', 'public.varieties', p) then
      raise exception 'RLS fix aborted: authenticated still has % on public.varieties', p;
    end if;
  end loop;

  -- 3d. row level security still on, and the four membership-gated varieties policies still present
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.varieties'::regclass) then
    raise exception 'RLS fix aborted: row level security is not enabled on public.varieties';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'varieties'
         and policyname in ('varieties_select_org', 'varieties_insert_org', 'varieties_update_org', 'varieties_delete_org')
         and roles = array['authenticated']::name[]) <> 4 then
    raise exception 'RLS fix aborted: the four varieties_*_org policies are not all present for authenticated';
  end if;

  -- 3e. legitimate authenticated access to memberships / organizations is untouched
  if (select count(*) from pg_policies
       where schemaname = 'public'
         and policyname in ('memberships_select_own', 'organizations_select_member')) <> 2 then
    raise exception 'RLS fix aborted: memberships/organizations select policies are not intact';
  end if;
end $$;

commit;
