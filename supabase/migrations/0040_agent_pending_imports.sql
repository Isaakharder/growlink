-- Migration 0040: agent_pending_imports
--
-- Stores parsed FlowMaster runs submitted by GrowLinkAgent that are
-- waiting for manual review in Yield Data Entry before writing yield_entries.
--
-- One row per lot number per organisation (UNIQUE constraint mirrors
-- yield_import_runs so duplicate-lot detection keeps working correctly).
-- On agent re-upload of the same lot the row is upserted, not duplicated.
-- Rows are hard-deleted when the user approves (import writes yield_import_runs)
-- or dismisses the pending record.

CREATE TABLE public.agent_pending_imports (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid        NOT NULL
                                       REFERENCES public.organizations(id)
                                       ON DELETE CASCADE,
  lot_number             text        NOT NULL,
  variety_name           text        NULL,          -- raw parsed string; matched at review time
  source_filename        text        NOT NULL,
  start_time             text        NULL,          -- "YYYY-MM-DD HH:mm" (parser output format)
  iso_year               int         NULL,
  iso_week               int         NULL,
  average_fruit_weight_g numeric     NULL,
  size_kg                jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- {GrowLinkSizeName: kg}
  parsed_total_kg        numeric     NULL,
  warnings               jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- string[]
  unknown_sizes          jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- string[]
  upload_key_label       text        NULL,
  source_type            text        NOT NULL DEFAULT 'agent',
  raw_payload            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  uploaded_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_pending_imports_org_lot_key
    UNIQUE (organization_id, lot_number)
);

CREATE INDEX agent_pending_imports_org_idx
  ON public.agent_pending_imports (organization_id);

CREATE INDEX agent_pending_imports_org_week_idx
  ON public.agent_pending_imports (organization_id, iso_year, iso_week);

ALTER TABLE public.agent_pending_imports ENABLE ROW LEVEL SECURITY;

-- Service role needs full access; the server uses the service-role key.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.agent_pending_imports TO service_role;
