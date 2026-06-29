-- Add timezone to payroll_settings so rounding is applied in the org's local time.
-- DEFAULT 'America/Toronto' backfills all existing rows without a separate UPDATE.
-- Value must be a valid IANA timezone name (e.g. 'Europe/Amsterdam').

ALTER TABLE public.payroll_settings
  ADD COLUMN timezone text NOT NULL DEFAULT 'America/Toronto';
