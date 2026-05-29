-- Migration 0042: Organization invites table and member permissions
--
-- Creates organization_invites to support email-based org invitations.
-- Extends memberships with position and permissions columns.
--
-- RLS on organization_invites follows the same org-isolation pattern used
-- for organizations and memberships: authenticated members may SELECT;
-- INSERT / UPDATE / DELETE are service-role only so token operations
-- (creation, verification, acceptance) stay server-side and token_hash
-- is never writable or deletable from the client.

-- ============================================================
-- SECTION 1: Extend memberships with position and permissions
-- ============================================================

alter table public.memberships
  add column if not exists position text,
  add column if not exists permissions jsonb not null default '{}'::jsonb;

-- ============================================================
-- SECTION 2: organization_invites table
-- ============================================================

create table if not exists public.organization_invites (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  email           text        not null,
  token_hash      text        not null unique,
  position        text,
  permissions     jsonb       not null default '{}'::jsonb,
  invited_by      uuid        references auth.users(id) on delete set null,
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists organization_invites_organization_id_idx
  on public.organization_invites (organization_id);

-- Supports server-side lookup by email during invite acceptance.
create index if not exists organization_invites_email_idx
  on public.organization_invites (email);

-- ============================================================
-- SECTION 3: RLS on organization_invites
-- ============================================================

alter table public.organization_invites enable row level security;

-- Org members can read pending invites scoped to their organization.
-- This lets the UI display who has been invited without exposing token_hash
-- in a writable way — token_hash is SELECT-visible but never client-writable.
create policy organization_invites_select_org on public.organization_invites
  for select
  to authenticated
  using (public.is_org_member(organization_id));

-- INSERT / UPDATE / DELETE: no authenticated policy → default deny.
-- Invite creation, token verification, and acceptance (setting accepted_at
-- and creating the membership row) are handled server-side via service role.

grant usage on schema public to anon, authenticated, service_role;
grant all on table public.organization_invites to anon, authenticated, service_role;
