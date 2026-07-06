-- Split payroll rounding into independent Start Time Rounding and End Time
-- Rounding settings (previously one shared rounding_interval_minutes applied
-- to both). Also adds an explicit toggle for the "early clock-in snaps to
-- work_day_start" rule, which used to be an unconditional part of start
-- rounding.
--
-- Defaults reproduce prior behavior for existing orgs: start rounds up,
-- end rounds down, early snap stays on. The intervals are backfilled below
-- from each org's existing rounding_interval_minutes rather than a flat 15,
-- so orgs that had customized the shared interval keep that value on both
-- the new start and end settings.
--
-- rounding_interval_minutes is intentionally left in place (not dropped):
-- the application no longer reads it once this migration ships, but keeping
-- it avoids a destructive change while the cutover is verified.

ALTER TABLE public.payroll_settings
  ADD COLUMN start_rounding_mode text NOT NULL DEFAULT 'up'
    CHECK (start_rounding_mode IN ('none', 'nearest', 'up', 'down')),
  ADD COLUMN start_rounding_interval_minutes integer NOT NULL DEFAULT 15
    CHECK (start_rounding_interval_minutes > 0),
  ADD COLUMN end_rounding_mode text NOT NULL DEFAULT 'down'
    CHECK (end_rounding_mode IN ('none', 'nearest', 'up', 'down')),
  ADD COLUMN end_rounding_interval_minutes integer NOT NULL DEFAULT 15
    CHECK (end_rounding_interval_minutes > 0),
  ADD COLUMN snap_early_clock_in_to_start boolean NOT NULL DEFAULT true;

UPDATE public.payroll_settings
SET start_rounding_interval_minutes = rounding_interval_minutes,
    end_rounding_interval_minutes   = rounding_interval_minutes;
