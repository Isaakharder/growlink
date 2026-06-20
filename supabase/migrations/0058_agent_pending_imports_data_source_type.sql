-- Migration 0058: add data_source_type to agent_pending_imports
--
-- Mirrors the column added to organization_upload_keys in 0057.
-- DEFAULT 'flowmaster' means all existing pending import rows are correctly
-- labelled without any backfill.

ALTER TABLE public.agent_pending_imports
  ADD COLUMN data_source_type text NOT NULL DEFAULT 'flowmaster'
  CHECK (data_source_type IN ('flowmaster', 'generic_csv'));

CREATE INDEX agent_pending_imports_source_type_idx
  ON public.agent_pending_imports (organization_id, data_source_type);
