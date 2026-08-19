-- Remove the legacy 100% upper bound on Daily Yield sample bin fill while
-- preserving non-negative validation.

ALTER TABLE public.daily_yield_samples
  DROP CONSTRAINT IF EXISTS daily_yield_samples_bin_fill_percent_check;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'daily_yield_samples'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%bin_fill_percent%'
      AND position('<=' in pg_get_constraintdef(c.oid)) > 0
      AND position('100' in pg_get_constraintdef(c.oid)) > 0
  LOOP
    EXECUTE format(
      'ALTER TABLE public.daily_yield_samples DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'daily_yield_samples'
      AND c.conname = 'daily_yield_samples_bin_fill_percent_non_negative_check'
  ) THEN
    ALTER TABLE public.daily_yield_samples
      ADD CONSTRAINT daily_yield_samples_bin_fill_percent_non_negative_check
      CHECK (bin_fill_percent >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'daily_yield_samples'
      AND c.conname = 'daily_yield_samples_percent_full_non_negative_check'
  ) THEN
    ALTER TABLE public.daily_yield_samples
      ADD CONSTRAINT daily_yield_samples_percent_full_non_negative_check
      CHECK (percent_full IS NULL OR percent_full >= 0);
  END IF;
END $$;
