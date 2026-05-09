-- Add source and synced_at fields to color_case_entries for tracking import source
alter table public.color_case_entries
add column if not exists source text default 'manual' check (source in ('manual', 'docklink')),
add column if not exists synced_at timestamptz,
add column if not exists source_summary jsonb;
