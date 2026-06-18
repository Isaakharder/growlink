-- Expand quality checks to support two check types: winding_pruning and picking_peppers.
-- All new columns default to 'winding_pruning' so existing rows remain valid.

-- ── quality_metrics ───────────────────────────────────────────────────────────

alter table public.quality_metrics
  add column if not exists check_type text not null default 'winding_pruning';

-- ── quality_thresholds ────────────────────────────────────────────────────────
-- Previously one row per org. Now one row per (org, check_type).

alter table public.quality_thresholds
  add column if not exists check_type text not null default 'winding_pruning';

-- Stamp the existing row so it's unambiguously the winding_pruning threshold.
update public.quality_thresholds
  set check_type = 'winding_pruning'
  where check_type is null or check_type = '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quality_thresholds_org_check_type_key'
      and conrelid = 'public.quality_thresholds'::regclass
  ) then
    alter table public.quality_thresholds
      add constraint quality_thresholds_org_check_type_key
      unique (organization_id, check_type);
  end if;
end $$;

-- ── quality_checks ────────────────────────────────────────────────────────────

alter table public.quality_checks
  add column if not exists check_type              text    not null default 'winding_pruning',
  add column if not exists slabs_checked           integer,
  add column if not exists stems_per_slab_snapshot numeric,
  add column if not exists total_stems_checked     numeric;
