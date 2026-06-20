-- Migration 0060: agent_pending_imports template support fields
--
-- lot_number made nullable: unconfigured imports (needs_template=true) arrive
-- before any column mapping exists, so no lot number can be extracted yet.
-- Postgres UNIQUE constraints treat NULLs as not-equal, so multiple unconfigured
-- rows per org are permitted — they won't conflict with each other or with
-- existing non-null lot number rows.
--
-- needs_template: set to true when a generic_csv file arrives with no saved
-- template. The admin mapping wizard clears this flag after applying a template.
--
-- upload_key_id: foreign key back to the upload key that submitted this file.
-- Required to filter pending imports by key in the apply-template operation.

ALTER TABLE public.agent_pending_imports
  ALTER COLUMN lot_number DROP NOT NULL;

ALTER TABLE public.agent_pending_imports
  ADD COLUMN needs_template boolean NOT NULL DEFAULT false;

ALTER TABLE public.agent_pending_imports
  ADD COLUMN upload_key_id uuid NULL REFERENCES public.organization_upload_keys(id) ON DELETE SET NULL;

CREATE INDEX agent_pending_imports_needs_template_idx
  ON public.agent_pending_imports (organization_id, needs_template)
  WHERE needs_template = true;

CREATE INDEX agent_pending_imports_upload_key_idx
  ON public.agent_pending_imports (upload_key_id);
