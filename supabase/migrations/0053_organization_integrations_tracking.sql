alter table public.organization_integrations
  add column if not exists connected_by_user_id uuid,
  add column if not exists connected_at timestamptz;
