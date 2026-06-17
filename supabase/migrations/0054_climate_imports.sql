-- Migration 0054: climate_imports
--
-- Import history for the GrowLink Climate Agent (Ridder/Synopta CSV
-- exports: weather station + block summary). One row per uploaded file;
-- file_hash is the duplicate-import guard, mirroring the lot-dedup
-- pattern used by yield_import_runs / agent_pending_imports.

CREATE TABLE public.climate_imports (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL
                                   REFERENCES public.organizations(id)
                                   ON DELETE CASCADE,
  source_file       text        NOT NULL,
  file_type         text        NOT NULL CHECK (file_type IN ('weather_station', 'block_summary')),
  export_timestamp  timestamptz NOT NULL,
  file_hash         text        NOT NULL,
  row_count         int         NOT NULL DEFAULT 0,
  upload_key_label  text        NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT climate_imports_org_file_hash_key UNIQUE (organization_id, file_hash)
);

CREATE INDEX climate_imports_org_export_ts_idx
  ON public.climate_imports (organization_id, export_timestamp DESC);

ALTER TABLE public.climate_imports ENABLE ROW LEVEL SECURITY;

-- Service role (used by the Express server) needs full access;
-- the climate agent never talks to Supabase directly.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.climate_imports TO service_role;
