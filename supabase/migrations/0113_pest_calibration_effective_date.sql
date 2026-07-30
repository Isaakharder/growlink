-- Calibration module — add a dedicated "performed date" separate from
-- "entered timestamp".
--
-- Today pest_calibration_records only has completed_at (the actual
-- submission instant) and created_at (the actual DB insertion instant,
-- effectively identical to completed_at in practice). There is no way to
-- record "this calibration was actually performed on July 15 but the
-- employee is only entering it on July 30" — completed_at conflates both.
--
-- effective_date is the employee-selected (and server-revalidated) calendar
-- date the calibration was actually performed, independent of when it was
-- entered. completed_at and created_at are left completely alone — neither
-- is backdated, so the audit trail still shows real entry time.
--
-- Backfill: existing rows (there are none as of this migration, but written
-- generically) get effective_date derived from their own completed_at,
-- read as a calendar date in the organization timezone (America/Toronto,
-- see server/src/config/orgTimezone.ts) — the closest honest approximation
-- for rows that predate this column, since no separate performed-date was
-- ever captured for them.

alter table public.pest_calibration_records
  add column effective_date date;

update public.pest_calibration_records
set effective_date = (completed_at at time zone 'America/Toronto')::date
where effective_date is null;

alter table public.pest_calibration_records
  alter column effective_date set not null;

-- effective_date is the primary display/filter/sort ordering going forward
-- (see records.ts) — completed_at/id remain as deterministic tiebreakers.
create index pest_calibration_records_org_effective_idx
  on public.pest_calibration_records (organization_id, effective_date desc, completed_at desc, id desc);
