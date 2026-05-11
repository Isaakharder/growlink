-- Import history table for PDF lot-level duplicate prevention and audit.
-- This table is not weekly yield data; it tracks imported packline runs.

CREATE TABLE IF NOT EXISTS public.yield_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  lot_number text NOT NULL,
  variety_id uuid NULL,
  iso_year int NULL,
  iso_week int NULL,
  start_time timestamptz NULL,
  source_filename text NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL
);

ALTER TABLE public.yield_import_runs
  ADD CONSTRAINT yield_import_runs_org_lot_key
  UNIQUE (organization_id, lot_number);

CREATE INDEX IF NOT EXISTS yield_import_runs_org_week_idx
  ON public.yield_import_runs (organization_id, iso_year, iso_week);

ALTER TABLE public.yield_import_runs ENABLE ROW LEVEL SECURITY;
