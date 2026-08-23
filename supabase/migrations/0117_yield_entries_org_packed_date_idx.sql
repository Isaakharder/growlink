-- Composite index to support cursor-based pagination of yield_entries by
-- packed_date (newest first) within an organization, matching the
-- (organization_id, packed_date desc nulls last, id desc) ordering used by
-- GET /api/yield-entries/recent. Without this the keyset query would fall
-- back to a full-table sort per page request.
create index if not exists yield_entries_org_packed_date_id_idx
  on public.yield_entries (organization_id, packed_date desc nulls last, id desc);
