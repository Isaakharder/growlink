-- Migration 0059: import_source_templates
--
-- Stores the column-mapping configuration for a specific upload key.
-- One template per upload key (UNIQUE constraint).
--
-- column_mappings shape (example):
-- {
--   "unique_key_column": "Lot Number",
--   "date_column":       "Pack Date",
--   "variety_column":    "Variety",
--   "kg_total_column":   "Total KG",
--   "size_columns": {
--     "Small":  "Weight_S",
--     "Medium": "Weight_M",
--     "Large":  "Weight_L"
--   }
-- }
--
-- Only "unique_key_column" is required; all other mappings are optional.
-- Unmapped columns are ignored during import.

CREATE TABLE public.import_source_templates (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id)  ON DELETE CASCADE,
  upload_key_id   uuid        NOT NULL REFERENCES public.organization_upload_keys(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  file_type       text        NOT NULL DEFAULT 'csv' CHECK (file_type IN ('csv')),
  column_mappings jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, upload_key_id)
);

CREATE INDEX import_source_templates_key_idx
  ON public.import_source_templates (upload_key_id);

ALTER TABLE public.import_source_templates ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.import_source_templates TO service_role;
