-- Migration 0057: add data_source_type to organization_upload_keys
--
-- 'flowmaster' covers the existing Windows agent uploading FlowMaster PDFs/CSVs.
-- 'generic_csv' covers any computer uploading arbitrary CSV exports that are
-- configured via the import template mapping wizard.
--
-- DEFAULT 'flowmaster' means every existing key continues to work unchanged.

ALTER TABLE public.organization_upload_keys
  ADD COLUMN data_source_type text NOT NULL DEFAULT 'flowmaster'
  CHECK (data_source_type IN ('flowmaster', 'generic_csv'));
