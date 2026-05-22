-- Migration 0038: Add missing FK from yield_import_runs.organization_id to organizations.
--
-- Migration 0022 created yield_import_runs with organization_id NOT NULL but
-- did not declare a FOREIGN KEY. This migration adds referential integrity so
-- that deleting an organization cascades to its import history rather than
-- leaving orphaned rows with dangling UUIDs.
--
-- Pre-flight check: before applying, verify there are no orphaned rows:
--   SELECT id, organization_id FROM public.yield_import_runs
--   WHERE organization_id NOT IN (SELECT id FROM public.organizations);
-- If that query returns any rows, delete or reassign them first.

ALTER TABLE public.yield_import_runs
  ADD CONSTRAINT yield_import_runs_org_fk
  FOREIGN KEY (organization_id)
  REFERENCES public.organizations(id)
  ON DELETE CASCADE;
