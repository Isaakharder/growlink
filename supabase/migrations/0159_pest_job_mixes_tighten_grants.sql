-- Migration 0159: least-privilege grants on the pest mix tables (0158).
--
-- The project's default privileges gave anon, authenticated and service_role
-- TRUNCATE, TRIGGER and REFERENCES on pest_job_mixes and
-- pest_job_mix_revisions when 0158 created them. Nothing uses those, and
-- TRUNCATE is not subject to row-level security. This removes them and
-- restates the access the tables are meant to have:
--
--   service_role   SELECT, INSERT, UPDATE, DELETE   (the Express server)
--   authenticated  SELECT, limited to the member's own organizations by the
--                  existing RLS policies (*_select_org → is_org_member)
--   anon           nothing
--
-- Row-level security stays enabled and the policies are unchanged, so access
-- stays organization-scoped. No data is touched. 0158 itself is not edited.
-- One transaction; safe to re-run.

begin;

revoke truncate, trigger, references on table public.pest_job_mixes from anon, authenticated, service_role, public;
revoke truncate, trigger, references on table public.pest_job_mix_revisions from anon, authenticated, service_role, public;

revoke all on table public.pest_job_mixes from anon;
revoke all on table public.pest_job_mix_revisions from anon;

revoke insert, update, delete on table public.pest_job_mixes from authenticated;
revoke insert, update, delete on table public.pest_job_mix_revisions from authenticated;

grant select, insert, update, delete on table public.pest_job_mixes to service_role;
grant select, insert, update, delete on table public.pest_job_mix_revisions to service_role;
grant select on table public.pest_job_mixes to authenticated;
grant select on table public.pest_job_mix_revisions to authenticated;

alter table public.pest_job_mixes enable row level security;
alter table public.pest_job_mix_revisions enable row level security;

commit;

-- Rollback (restores the previous default-privilege grants):
-- begin;
-- grant truncate, trigger, references on table public.pest_job_mixes to anon, authenticated, service_role;
-- grant truncate, trigger, references on table public.pest_job_mix_revisions to anon, authenticated, service_role;
-- commit;
