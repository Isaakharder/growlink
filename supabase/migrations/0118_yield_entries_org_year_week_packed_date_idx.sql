-- Supersedes yield_entries_org_packed_date_id_idx (0117): GET
-- /api/yield-entries/recent now orders by (year desc, week desc,
-- packed_date desc nulls last, id desc) instead of packed_date alone, so a
-- null-packed_date entry sorts alongside its own week instead of behind all
-- dated history. The old 3-column index doesn't match this leading-column
-- order and would no longer be used by that query, so it's dropped rather
-- than left behind as dead weight.
drop index if exists public.yield_entries_org_packed_date_id_idx;

create index if not exists yield_entries_org_year_week_packed_date_id_idx
  on public.yield_entries (organization_id, year desc, week desc, packed_date desc nulls last, id desc);
