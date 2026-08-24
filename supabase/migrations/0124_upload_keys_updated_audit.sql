-- Adds an audit trail to organization_upload_keys so administrative
-- changes (e.g. changing data_source_type) can record who made the change
-- and when. Nullable/defaulted so existing rows need no backfill.

alter table public.organization_upload_keys
  add column if not exists updated_at timestamptz not null default now();

alter table public.organization_upload_keys
  add column if not exists updated_by uuid null;
