-- Short, worker-facing instructions for a location, distinct from the
-- existing `notes` column (administrative/internal, shown in the print
-- header — see PrintableLocationReport.tsx). mobile_instructions is read
-- only by the mobile checklist page and is deliberately NEVER copied into
-- food_safety_cleaning_reports/report_items: it is current operational
-- guidance, not part of the immutable historical snapshot, so editing it
-- later must have no effect on any past report.
--
-- No length check constraint here, consistent with `notes` (migration
-- 0096), which also enforces its max length at the application layer only.

alter table public.food_safety_cleaning_locations
  add column if not exists mobile_instructions text;
