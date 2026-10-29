-- Migration 0149: Close anonymous read access to First Light's quality data on
-- public.quality_checks and public.quality_employees.
--
-- Evidence (live pg_policies + privilege audit and a rolled-back role probe, 2026-10-29):
--   quality_checks_tv_read_first_light and quality_employees_tv_read_first_light are
--   `for select to anon using (organization_id = 'e1b8a6cf-…' /* First Light */)`,
--   created outside the migrations. Combined with the full privileges anon holds from
--   0035 (`grant all … to anon`), anyone with the public (publishable) API key can read
--   every First Light quality check (all columns, incl. notes, metric counts and the
--   creating user's id) and every First Light quality employee name. anon writes are
--   already refused by RLS (no anon insert/update/delete policies), and no other
--   organization is exposed.
--
-- The GrowLink web and iOS clients never query these tables through PostgREST; the
-- Quality module goes through the Express server (service role, bypasses RLS, gated by
-- quality:* / mobile:quality permissions and filtered by organization_id), which is not
-- affected by any change below.
--
-- Unchanged: the membership-gated authenticated policies (quality_checks_select/_insert,
-- quality_employees_select/_insert/_update, using public.is_org_member) and
-- authenticated's SELECT/INSERT/UPDATE/DELETE grants. Both policies are dropped by exact
-- name; nothing is removed by pattern or by expression text.

begin;

-- ============================================================
-- 1. Remove the anonymous TV read policies (exact names)
-- ============================================================
drop policy if exists quality_checks_tv_read_first_light    on public.quality_checks;
drop policy if exists quality_employees_tv_read_first_light on public.quality_employees;

-- ============================================================
-- 2. Privileges
--    anon gets nothing. authenticated keeps SELECT/INSERT/UPDATE/DELETE (governed by
--    the is_org_member policies); the whole-table privileges that sidestep row-level
--    security (TRUNCATE, REFERENCES, TRIGGER) are removed, as in 0137.
-- ============================================================
revoke all on table public.quality_checks    from anon;
revoke all on table public.quality_employees from anon;
revoke truncate, references, trigger on table public.quality_checks    from authenticated;
revoke truncate, references, trigger on table public.quality_employees from authenticated;

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
    and tablename in ('quality_checks', 'quality_employees')
    and roles && array['public', 'anon']::name[];
  if leftover is not null then
    raise exception '0149 aborted: public/anon policies remain: %', leftover;
  end if;

  foreach t in array array['quality_checks', 'quality_employees'] loop
    -- 3b. anon holds no privilege of any kind (table-level, column-level or via PUBLIC)
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', format('public.%I', t), p) then
        raise exception '0149 aborted: anon still has % on public.%', p, t;
      end if;
    end loop;
    if has_any_column_privilege('anon', format('public.%I', t), 'SELECT, INSERT, UPDATE, REFERENCES') then
      raise exception '0149 aborted: anon still has a column privilege on public.%', t;
    end if;

    -- 3c. authenticated: no privilege that sidesteps RLS, and RLS still on
    foreach p in array array['TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('authenticated', format('public.%I', t), p) then
        raise exception '0149 aborted: authenticated still has % on public.%', p, t;
      end if;
    end loop;
    if not (select c.relrowsecurity from pg_class c where c.oid = format('public.%I', t)::regclass) then
      raise exception '0149 aborted: row level security is not enabled on public.%', t;
    end if;
  end loop;

  -- 3d. the membership-gated authenticated policies are all still present
  if (select count(*) from pg_policies
       where schemaname = 'public'
         and policyname in ('quality_checks_select', 'quality_checks_insert',
                            'quality_employees_select', 'quality_employees_insert', 'quality_employees_update')
         and roles = array['authenticated']::name[]) <> 5 then
    raise exception '0149 aborted: the is_org_member quality policies are not all present for authenticated';
  end if;
end $$;

commit;

-- ROLLBACK (restores the exact pre-0149 state, including the anonymous exposure):
-- begin;
-- create policy quality_checks_tv_read_first_light on public.quality_checks for select to anon using (organization_id = 'e1b8a6cf-032c-48f0-852a-982dd58b9f9c'::uuid);
-- create policy quality_employees_tv_read_first_light on public.quality_employees for select to anon using (organization_id = 'e1b8a6cf-032c-48f0-852a-982dd58b9f9c'::uuid);
-- grant all on table public.quality_checks to anon;
-- grant all on table public.quality_employees to anon;
-- grant truncate, references, trigger on table public.quality_checks to authenticated;
-- grant truncate, references, trigger on table public.quality_employees to authenticated;
-- commit;
