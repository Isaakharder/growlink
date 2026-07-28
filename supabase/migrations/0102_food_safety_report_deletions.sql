-- Controlled, audited deletion of Food Safety reports.
--
-- Reports are deliberately immutable (see 0088/0090's trigger guard) so a
-- completed audit record can never be silently altered. This adds a single,
-- narrow escape hatch for genuine mistakes (wrong location, a stale
-- duplicate, etc.): a permissioned admin action that deletes exactly one
-- report + its items, after writing a complete snapshot of what's being
-- removed to an append-only audit table. There is deliberately no "restore"
-- path and no update/delete grant on the audit table itself.
--
-- Security-hardening note discovered while building this: every prior
-- food_safety_* RPC (0085 onward) was created with `grant execute ...
-- to service_role`, but PostgreSQL grants EXECUTE on a new function to
-- PUBLIC by default -- adding a grant for service_role never revokes that
-- default, so every one of those RPCs has been callable directly by ANY
-- authenticated Supabase session all along (verified against a real replay
-- of the full migration history: `has_function_privilege('authenticated',
-- 'food_safety_get_or_create_checklist(...)', 'EXECUTE')` returns true).
-- For the plain (non-SECURITY-DEFINER) RPCs that's bounded somewhat by RLS
-- (is_org_member still constrains which organization_id a direct caller can
-- act on) but still completely bypasses the Express layer's permission-key
-- checks (mobile:food_safety, food_safety:edit, etc.) -- a logged-in user
-- with none of those permissions could call the RPC straight from the
-- client SDK. For a SECURITY DEFINER function it would be far worse, since
-- DEFINER bypasses RLS entirely -- exactly the class of function this
-- migration adds. Revoking PUBLIC's default EXECUTE is therefore both
-- required for the new delete RPC and a straightforward, purely-additive
-- fix (no legitimate caller is affected -- the Express server has only ever
-- used the service-role key) for every existing one while this file is
-- already touching RPC grants.

create table if not exists public.food_safety_report_deletions (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        not null references public.organizations(id) on delete cascade,
  -- Intentionally NOT a foreign key -- the row it would reference is exactly
  -- what this table exists to outlive.
  report_id              uuid        not null,
  location_id            uuid,
  -- Populated only when the deleted report's checklist_signature names
  -- exactly one real checklist attempt (the common case); null for
  -- legacy/backfill reports (no checklist) or the rare multi-checklist
  -- combined-report case -- report_snapshot always has the full list either way.
  checklist_id           uuid,
  completed_at           timestamptz not null,
  completed_by_user_id   uuid        references auth.users(id) on delete set null,
  completed_by_name      text,
  completed_by_initials  text,
  deleted_by_user_id     uuid        references auth.users(id) on delete set null,
  deleted_by_email       text,
  deletion_reason        text        not null,
  report_snapshot        jsonb       not null,
  deleted_at             timestamptz not null default now()
);

create index if not exists food_safety_report_deletions_org_idx
  on public.food_safety_report_deletions (organization_id);

create index if not exists food_safety_report_deletions_report_idx
  on public.food_safety_report_deletions (report_id);

create index if not exists food_safety_report_deletions_location_idx
  on public.food_safety_report_deletions (location_id);

create index if not exists food_safety_report_deletions_deleted_at_idx
  on public.food_safety_report_deletions (deleted_at desc);

alter table public.food_safety_report_deletions enable row level security;

-- Read access follows the same org-isolation pattern as every other
-- Food Safety table so a future audit-history UI can query this directly
-- through the normal authenticated client without any new RLS work --
-- nothing currently reads this table, but there's no reason its policy
-- should be any less permissive than food_safety_cleaning_reports' own.
drop policy if exists food_safety_report_deletions_select_org on public.food_safety_report_deletions;
create policy food_safety_report_deletions_select_org on public.food_safety_report_deletions
  for select to authenticated
  using (public.is_org_member(organization_id));

-- No insert/update/delete policy for `authenticated` at all -- this table is
-- only ever written by the service-role-only RPC below.
grant select on table public.food_safety_report_deletions to service_role;
grant insert on table public.food_safety_report_deletions to service_role;


-- Tombstone: set on whichever checklist(s) produced a report that has since
-- been deleted, so maybeCreateReport() (reportGeneration.ts) knows never to
-- silently regenerate it -- see that function's own check. Null means
-- "nothing to skip", the default/steady state for every checklist.
alter table public.food_safety_cleaning_checklists
  add column if not exists report_deleted_at timestamptz;


-- The one and only way a report may be deleted. SECURITY DEFINER (unlike
-- this file group's other RPCs, which run fine as INVOKER since service_role
-- already has direct table grants) because this specific function needs to
-- disable/re-enable an immutability trigger mid-transaction -- an explicit,
-- narrowly-scoped elevation for a genuinely higher-stakes operation, with a
-- fixed search_path and fully schema-qualified references throughout so it
-- can't be redirected by a hostile search_path.
--
-- Order of operations: validate the reason -> lock the report (NOWAIT, so a
-- second concurrent delete attempt gets an immediate, mappable conflict
-- instead of hanging) -> 404 if it doesn't exist in this organization ->
-- snapshot report + items + contributing checklist(s) into one jsonb blob ->
-- write the audit row -> tombstone the contributing checklist(s) -> disable
-- both immutability triggers -> delete the report (items cascade via the
-- existing FK) -> re-enable both triggers. Any exception at any point rolls
-- back the entire transaction, including the trigger-disable DDL.
create or replace function public.food_safety_delete_report(
  p_organization_id uuid,
  p_report_id uuid,
  p_deleted_by_user_id uuid,
  p_deleted_by_email text,
  p_deletion_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.food_safety_cleaning_reports;
  v_items jsonb;
  v_checklist_ids uuid[];
  v_checklists jsonb;
  v_found_checklist_count integer;
  v_single_checklist_id uuid;
begin
  if p_deletion_reason is null or length(trim(p_deletion_reason)) < 5 then
    raise exception 'A deletion reason of at least 5 characters is required.'
      using errcode = 'GL010';
  end if;

  begin
    select * into v_report
    from public.food_safety_cleaning_reports
    where id = p_report_id and organization_id = p_organization_id
    for update nowait;
  exception
    when lock_not_available then
      raise exception 'This report is currently being modified by another request. Try again.'
        using errcode = 'GL011';
  end;

  if v_report.id is null then
    raise exception 'Report % not found in organization %', p_report_id, p_organization_id
      using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(to_jsonb(i.*) order by i.sort_order), '[]'::jsonb)
  into v_items
  from public.food_safety_cleaning_report_items i
  where i.report_id = p_report_id;

  -- Derive contributing checklist id(s) from checklist_signature, when it
  -- represents real checklist attempts rather than a legacy/backfill filler
  -- value (see reportGeneration.ts's buildChecklistSignature and
  -- backfill.ts) -- those have no checklist row to tombstone.
  if v_report.checklist_signature is not null
     and v_report.checklist_signature not like 'legacy:%'
     and v_report.checklist_signature not like 'backfill:%'
  then
    select array_agg(x::uuid) into v_checklist_ids
    from unnest(string_to_array(v_report.checklist_signature, '|')) as x;
  end if;

  if v_checklist_ids is not null then
    select coalesce(jsonb_agg(to_jsonb(c.*)), '[]'::jsonb), count(*)
    into v_checklists, v_found_checklist_count
    from public.food_safety_cleaning_checklists c
    where c.id = any(v_checklist_ids);

    -- Data-integrity guard: checklist_signature named id(s) that no longer
    -- resolve to real rows (should be unreachable -- checklists are never
    -- hard-deleted -- but refuse to guess rather than silently skip the
    -- tombstone step if this codebase's assumptions ever change).
    if v_found_checklist_count <> array_length(v_checklist_ids, 1) then
      raise exception 'This report''s checklist history is inconsistent and cannot be safely deleted right now.'
        using errcode = 'GL011';
    end if;

    if array_length(v_checklist_ids, 1) = 1 then
      v_single_checklist_id := v_checklist_ids[1];
    end if;
  else
    v_checklists := '[]'::jsonb;
  end if;

  insert into public.food_safety_report_deletions (
    organization_id, report_id, location_id, checklist_id,
    completed_at, completed_by_user_id, completed_by_name, completed_by_initials,
    deleted_by_user_id, deleted_by_email, deletion_reason, report_snapshot
  ) values (
    p_organization_id, v_report.id, v_report.location_id, v_single_checklist_id,
    v_report.completed_at, v_report.completed_by_user_id, v_report.completed_by_name, v_report.completed_by_initials,
    p_deleted_by_user_id, p_deleted_by_email, p_deletion_reason,
    jsonb_build_object(
      'report', to_jsonb(v_report.*),
      'report_items', v_items,
      'checklists', v_checklists,
      'checklist_ids', to_jsonb(v_checklist_ids)
    )
  );

  if v_checklist_ids is not null then
    update public.food_safety_cleaning_checklists
    set report_deleted_at = now()
    where id = any(v_checklist_ids);
  end if;

  alter table public.food_safety_cleaning_reports disable trigger food_safety_cleaning_reports_immutable;
  alter table public.food_safety_cleaning_report_items disable trigger food_safety_cleaning_report_items_immutable;

  delete from public.food_safety_cleaning_reports where id = p_report_id;
  -- report_items cascade-delete automatically (on delete cascade FK, 0088).

  alter table public.food_safety_cleaning_reports enable trigger food_safety_cleaning_reports_immutable;
  alter table public.food_safety_cleaning_report_items enable trigger food_safety_cleaning_report_items_immutable;
end;
$$;

revoke execute on function public.food_safety_delete_report(uuid, uuid, uuid, text, text) from public;
grant execute on function public.food_safety_delete_report(uuid, uuid, uuid, text, text) to service_role;


-- Close the same gap on every pre-existing food_safety_* RPC (see this
-- file's header comment) -- purely additive, no legitimate caller is
-- affected. Each one already has its own `grant ... to service_role` from
-- the migration that created it; this only removes the default PUBLIC grant
-- that was never explicitly revoked anywhere.
revoke execute on function public.food_safety_get_or_create_checklist(uuid, uuid, text, text) from public;
revoke execute on function public.food_safety_start_new_checklist_attempt(uuid, uuid, text, text) from public;
revoke execute on function public.food_safety_complete_location_checklists(uuid, uuid[], uuid, text, text) from public;
revoke execute on function public.food_safety_set_checklist_item_response(uuid, uuid, text, uuid, text, text) from public;
revoke execute on function public.food_safety_latest_reports_for_locations(uuid, uuid[]) from public;
