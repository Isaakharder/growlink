-- Upload keys for the Flow Master Windows agent.
-- Raw keys are never stored; only the SHA-256 hash is kept.

CREATE TABLE IF NOT EXISTS public.organization_upload_keys (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key_hash        text        NOT NULL UNIQUE,
  label           text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NULL
);

CREATE INDEX IF NOT EXISTS upload_keys_org_idx
  ON public.organization_upload_keys (organization_id);

-- Partial index for fast active-key lookups by hash
CREATE INDEX IF NOT EXISTS upload_keys_active_hash_idx
  ON public.organization_upload_keys (key_hash)
  WHERE status = 'active';

ALTER TABLE public.organization_upload_keys ENABLE ROW LEVEL SECURITY;
