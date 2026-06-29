-- Audit columns for manager edits to payroll_time_logs.
-- All nullable so existing rows carry no edit history.

ALTER TABLE public.payroll_time_logs
  ADD COLUMN edited_at  timestamptz,
  ADD COLUMN edited_by  uuid,
  ADD COLUMN edit_note  text;
