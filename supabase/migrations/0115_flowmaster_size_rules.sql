-- FlowMaster size resolution rules.
--
-- The PDF/CSV import preview (server/src/routes/pdfImport.ts) flags any
-- FlowMaster size label that doesn't canonically match an active
-- yield_sizes row as "unknown" and blocks import until it's resolved. Until
-- now there was no UI or storage for actually resolving an unknown label —
-- this table is the saved, per-organization resolution rule for a given
-- raw FlowMaster label, applied automatically on every future import.
--
-- action:
--   'create'      — label resolves to a newly-created yield_sizes row
--                    (target_size_id points at it). Functionally identical
--                    to 'map' at apply-time; kept distinct only so the
--                    setup UI can show which choice the user made.
--   'map'         — label resolves to an already-existing yield_sizes row
--                    with a different name (target_size_id).
--   'ignore'      — label's kg is dropped entirely (e.g. "Class 1" is a
--                    grade/subtotal that would double-count production if
--                    added on top of the real sizes it summarizes).
--   'distribute'  — label's kg is split proportionally across
--                    distribute_size_ids, weighted by those sizes' own kg
--                    within the same parsed file (e.g. "24 ct" isn't a
--                    real size on its own, so its kg is folded back into
--                    SXL/XL/XXL in proportion to how much of each was
--                    already packed in that run).
--
-- raw_label_normalized is a generated column (trim+lower) so lookups by
-- label are case/whitespace-insensitive; it doubles as the upsert conflict
-- target per this repo's convention of promoting generated columns to a
-- named unique constraint rather than a bare index.

create table public.flowmaster_size_rules (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        not null references public.organizations(id) on delete cascade,
  raw_label             text        not null,
  raw_label_normalized  text        generated always as (lower(trim(raw_label))) stored,
  action                text        not null check (action in ('create', 'map', 'ignore', 'distribute')),
  target_size_id        uuid        references public.yield_sizes(id) on delete set null,
  distribute_size_ids   uuid[]      not null default '{}',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint flowmaster_size_rules_org_label_unique unique (organization_id, raw_label_normalized)
);

create index flowmaster_size_rules_org_idx on public.flowmaster_size_rules (organization_id);

alter table public.flowmaster_size_rules enable row level security;

create policy flowmaster_size_rules_select_org on public.flowmaster_size_rules
  for select to authenticated using (public.is_org_member(organization_id));
create policy flowmaster_size_rules_insert_org on public.flowmaster_size_rules
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy flowmaster_size_rules_update_org on public.flowmaster_size_rules
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy flowmaster_size_rules_delete_org on public.flowmaster_size_rules
  for delete to authenticated using (public.is_org_member(organization_id));

grant select, insert, update, delete on table public.flowmaster_size_rules to service_role;
