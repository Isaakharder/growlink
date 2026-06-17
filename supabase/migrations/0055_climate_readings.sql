-- Migration 0055: climate_readings
--
-- Long/EAV time-series fact table for climate telemetry parsed from Ridder
-- CSV exports (weather station + block summary). zone_label is NULL for
-- whole-site readings; populated with the zone/room/station label otherwise.
--
-- zone_key is a generated column mirroring COALESCE(zone_label, ''), used
-- as the dedupe constraint instead of zone_label directly: Postgres treats
-- NULL as distinct in unique constraints (which would defeat dedup for
-- NULL-zone readings), and Supabase/PostgREST's upsert(onConflict: ...)
-- requires the conflict target to be a plain column list, not an
-- expression -- a generated column satisfies both constraints.

CREATE TABLE public.climate_readings (
  id                bigserial        PRIMARY KEY,
  organization_id   uuid             NOT NULL
                                        REFERENCES public.organizations(id)
                                        ON DELETE CASCADE,
  import_id         uuid             NOT NULL
                                        REFERENCES public.climate_imports(id)
                                        ON DELETE CASCADE,
  "timestamp"       timestamptz      NOT NULL,
  zone_label        text             NULL,
  zone_key          text             GENERATED ALWAYS AS (COALESCE(zone_label, '')) STORED,
  metric_name       text             NOT NULL,
  metric_value      double precision NOT NULL,
  unit              text             NOT NULL,
  source_file       text             NOT NULL,
  created_at        timestamptz      NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX climate_readings_dedupe_idx
  ON public.climate_readings (organization_id, "timestamp", zone_key, metric_name);

CREATE INDEX climate_readings_org_metric_ts_idx
  ON public.climate_readings (organization_id, metric_name, "timestamp" DESC);

CREATE INDEX climate_readings_org_zone_ts_idx
  ON public.climate_readings (organization_id, zone_label, "timestamp" DESC);

ALTER TABLE public.climate_readings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.climate_readings TO service_role;
