-- Support for the Food Safety Setup > Logs Backfill generator: bulk-creates
-- historical completed cleaning reports for a location (see
-- server/src/routes/foodSafety/backfill.ts). Backfilled rows go through the
-- exact same food_safety_cleaning_reports/_report_items tables real mobile
-- completions use — so they appear in Food Safety Reports automatically —
-- but are tagged so they can be distinguished from real completions later.
--
-- generated_by_user_id/generated_at describe the admin who ran the backfill
-- and when, which is different from completed_by_user_id/completed_at (the
-- synthetic "who completed it and when" snapshot chosen for that historical
-- day). backfill_batch_id groups every report created by one generation run
-- without needing a separate batches table.

alter table public.food_safety_cleaning_reports
  add column if not exists source text not null default 'mobile' check (source in ('mobile', 'backfill')),
  add column if not exists generated_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists generated_at timestamptz,
  add column if not exists backfill_batch_id uuid;

create index if not exists food_safety_cleaning_reports_backfill_batch_idx
  on public.food_safety_cleaning_reports (backfill_batch_id)
  where backfill_batch_id is not null;

-- Grant unchanged from migration 0088 (select, insert only) — immutability
-- of this table is enforced by the existing trigger, and backfilled rows
-- must be just as immutable as real completions once created.
grant select, insert on table public.food_safety_cleaning_reports to service_role;
