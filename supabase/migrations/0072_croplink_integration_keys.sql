-- Read-only integration keys for external products (e.g. CropLink) to call
-- GrowLink's /api/integrations/* endpoints. Distinct from
-- organization_upload_keys, which grants write access for inbound agent
-- uploads — these keys only ever back read-only queries.
-- Raw keys are never stored; only the SHA-256 hash is kept.

create table if not exists public.organization_integration_keys (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null references public.organizations(id) on delete cascade,
  integration_name text        not null check (integration_name in ('croplink')),
  key_hash         text        not null unique,
  label            text        not null,
  status           text        not null default 'active' check (status in ('active', 'revoked')),
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz
);

create index if not exists organization_integration_keys_org_idx
  on public.organization_integration_keys (organization_id);

-- Partial index for fast active-key lookups by hash
create index if not exists organization_integration_keys_active_hash_idx
  on public.organization_integration_keys (key_hash)
  where status = 'active';

alter table public.organization_integration_keys enable row level security;

drop policy if exists organization_integration_keys_select on public.organization_integration_keys;
create policy organization_integration_keys_select on public.organization_integration_keys
  for select to public using (true);

drop policy if exists organization_integration_keys_insert on public.organization_integration_keys;
create policy organization_integration_keys_insert on public.organization_integration_keys
  for insert to public with check (true);

drop policy if exists organization_integration_keys_update on public.organization_integration_keys;
create policy organization_integration_keys_update on public.organization_integration_keys
  for update to public using (true) with check (true);

drop policy if exists organization_integration_keys_delete on public.organization_integration_keys;
create policy organization_integration_keys_delete on public.organization_integration_keys
  for delete to public using (true);

grant select, insert, update, delete on table public.organization_integration_keys to service_role;
